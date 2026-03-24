import base64
import hashlib
import math
import os
import random
import time

import cv2
import numpy as np
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By

from cnki_page_state import capture_page_artifacts, get_page_state, page_has_visible_captcha

_SESSION_CAPTCHA_STATE = {}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _decode_data_url(src: str):
    if not src or "data:image" not in src or "," not in src:
        return None
    try:
        raw = base64.b64decode(src.split(",", 1)[1])
    except Exception:
        return None
    arr = np.frombuffer(raw, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)


def _extract_captcha_assets(driver):
    payload = driver.execute_script(
        """
        const isVisible = (el) => !!(
          el &&
          ((el.offsetParent !== null) ||
           (el.getClientRects && el.getClientRects().length > 0))
        );
        const canvases = Array.from(document.querySelectorAll('canvas'))
          .filter(c => isVisible(c) && c.width >= 30 && c.height >= 30)
          .map(c => ({ src: c.toDataURL(), width: c.width, height: c.height }));
        const imgs = Array.from(document.querySelectorAll('img'))
          .map(i => ({
            src: i.currentSrc || i.src || '',
            width: i.naturalWidth || i.width || 0,
            height: i.naturalHeight || i.height || 0,
            displayWidth: i.getBoundingClientRect().width || 0,
            displayHeight: i.getBoundingClientRect().height || 0,
            visible: isVisible(i),
          }))
          .filter(i => i.visible && i.width >= 30 && i.height >= 30 && i.src.startsWith('data:image'));
        const displayCandidates = [
          ...Array.from(document.querySelectorAll('.verify-img-panel img, .verify-img-panel canvas')),
          ...Array.from(document.querySelectorAll('img, canvas'))
        ]
          .filter(isVisible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              width: rect.width || 0,
              height: rect.height || 0,
              area: (rect.width || 0) * (rect.height || 0),
            };
          })
          .filter(item => item.width >= 30 && item.height >= 30)
          .sort((a, b) => b.area - a.area);
        return {
          canvases,
          imgs,
          displayWidth: displayCandidates.length ? displayCandidates[0].width : 0
        };
        """
    )

    images = []
    for item in payload.get("canvases", []):
        images.append(
            {
                "src": item.get("src", ""),
                "width": int(item.get("width") or 0),
                "height": int(item.get("height") or 0),
            }
        )
    for item in payload.get("imgs", []):
        images.append(
            {
                "src": item.get("src", ""),
                "width": int(item.get("width") or 0),
                "height": int(item.get("height") or 0),
            }
        )

    bg_item = None
    slice_item = None
    sorted_images = sorted(images, key=lambda x: (x["width"] * x["height"]), reverse=True)
    for item in sorted_images:
        if item["width"] >= 180 and item["height"] >= 80:
            bg_item = item
            break
    if bg_item is None:
        return None

    for item in sorted_images:
        if item is bg_item:
            continue
        if 20 <= item["width"] <= 120 and item["height"] >= 60:
            slice_item = item
            break
    if slice_item is None:
        return None

    bg = _decode_data_url(bg_item["src"])
    slc = _decode_data_url(slice_item["src"])
    if bg is None or slc is None:
        return None

    signature_source = "|".join(
        [
            bg_item["src"][:160],
            slice_item["src"][:160],
            str(bg_item["width"]),
            str(bg_item["height"]),
            str(slice_item["width"]),
            str(slice_item["height"]),
        ]
    )

    return {
        "bg": bg,
        "slice": slc,
        "display_width": float(payload.get("displayWidth") or 0),
        "signature": hashlib.sha1(signature_source.encode("utf-8")).hexdigest(),
    }


def _to_gray(img: np.ndarray) -> np.ndarray:
    if img is None:
        return img
    if len(img.shape) == 2:
        return img
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _extract_masked_template(slc: np.ndarray):
    if slc is None:
        return None, None
    gray = _to_gray(slc)
    mask = None
    if len(slc.shape) == 3 and slc.shape[2] == 4:
        alpha = slc[:, :, 3]
        mask = cv2.threshold(alpha, 15, 255, cv2.THRESH_BINARY)[1]
    else:
        mask = cv2.threshold(gray, 8, 255, cv2.THRESH_BINARY)[1]

    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return gray, None

    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    tpl = gray[y0:y1, x0:x1]
    tpl_mask = mask[y0:y1, x0:x1]
    return tpl, tpl_mask


def _estimate_distance(bg: np.ndarray, slc: np.ndarray):
    bg_gray = _to_gray(bg)
    tpl_gray, tpl_mask = _extract_masked_template(slc)
    if tpl_gray is None or tpl_gray.size == 0:
        return None, 0.0

    candidates = []
    edge_bg = cv2.Canny(bg_gray, 80, 180)
    edge_tpl = cv2.Canny(tpl_gray, 80, 180)

    try:
        if tpl_mask is not None:
            res_edge = cv2.matchTemplate(edge_bg, edge_tpl, cv2.TM_CCORR_NORMED, mask=tpl_mask)
            _, max_val, _, max_loc = cv2.minMaxLoc(res_edge)
            if math.isfinite(float(max_val)):
                candidates.append((float(max_val), int(max_loc[0])))
    except cv2.error:
        pass

    res_gray = cv2.matchTemplate(bg_gray, tpl_gray, cv2.TM_CCOEFF_NORMED)
    _, max_val_gray, _, max_loc_gray = cv2.minMaxLoc(res_gray)
    if math.isfinite(float(max_val_gray)):
        candidates.append((float(max_val_gray), int(max_loc_gray[0])))

    if not candidates:
        return None, 0.0

    best_score, best_x = max(candidates, key=lambda item: item[0])
    return best_x, best_score


def generate_human_tracks(distance: int):
    distance = max(1, int(round(distance)))
    overshoot = random.randint(2, 6)
    target = distance + overshoot
    step_count = random.randint(22, 34)
    tracks = []
    moved = 0

    for i in range(step_count):
        remain = target - moved
        if remain <= 0:
            break
        ratio = (i + 1) / step_count
        eased = 1 - (1 - ratio) * (1 - ratio)
        expected = int(round(target * eased))
        dx = max(1, expected - moved)
        dx = min(dx, remain)
        moved += dx
        dy = random.choice([-1, 0, 0, 1])
        dt = random.uniform(0.008, 0.022)
        tracks.append((dx, dy, dt))

    pull_back = moved - distance
    while pull_back > 0:
        back = min(pull_back, random.randint(1, 2))
        tracks.append((-back, random.choice([-1, 0, 1]), random.uniform(0.03, 0.08)))
        pull_back -= back

    tracks.append((0, 0, random.uniform(0.08, 0.20)))

    min_total = _env_float("CNKI_CAPTCHA_MIN_TRACK_SECONDS", 0.95)
    total = sum(item[2] for item in tracks)
    if total < min_total:
        tracks.append((0, 0, min_total - total))
    return tracks


def _perform_drag(driver, handle, tracks):
    chain = ActionChains(driver)
    chain.click_and_hold(handle)
    for dx, dy, dt in tracks:
        if dx or dy:
            chain.move_by_offset(dx, dy)
        if dt > 0:
            chain.pause(dt)
    chain.release()
    chain.perform()


def _slider_handle(driver):
    return driver.execute_script(
        """
        return document.querySelector('.verify-move-block')
          || document.querySelector('.geetest_slider_button')
          || document.querySelector('.verify-slider-btn')
          || document.querySelector('.slider-btn')
          || document.querySelector('.yidun_slider');
        """
    )


def _captcha_assets_ready(assets) -> bool:
    return bool(assets and float(assets.get("display_width") or 0) > 0)


def _refresh_captcha(driver) -> bool:
    button = driver.execute_script(
        """
        return document.querySelector('.verify-refresh')
          || document.querySelector('.geetest_refresh')
          || document.querySelector('.yidun_refresh')
          || document.querySelector('[class*="refresh"]');
        """
    )
    if not button:
        return False
    try:
        button.click()
    except Exception:
        driver.execute_script("arguments[0].click();", button)
    time.sleep(_env_float("CNKI_CAPTCHA_REFRESH_WAIT_SECONDS", 1.2))
    return True


def _session_state(driver):
    session_id = getattr(driver, "session_id", "") or "default"
    return _SESSION_CAPTCHA_STATE.setdefault(
        session_id,
        {
            "last_signature": "",
            "last_success": None,
        },
    )


def _captcha_still_active(driver, previous_signature: str = "") -> bool:
    state = get_page_state(driver)
    if page_has_visible_captcha(state) or state.get("captchaHandleVisible"):
        return True
    if previous_signature:
        assets = _extract_captcha_assets(driver)
        if assets is not None and assets.get("signature") == previous_signature:
            return True
    return False


def attempt_solve_in_context(driver):
    try:
        assets = _extract_captcha_assets(driver)
        if assets is None:
            return False
        if not _captcha_assets_ready(assets):
            time.sleep(_env_float("CNKI_CAPTCHA_ASSET_WAIT_SECONDS", 0.6))
            assets = _extract_captcha_assets(driver)
        if not _captcha_assets_ready(assets) and _refresh_captcha(driver):
            assets = _extract_captcha_assets(driver)
        if not _captcha_assets_ready(assets):
            print("Captcha assets are not visible yet; skip this solve attempt.")
            return False
        state = _session_state(driver)
        signature = assets.get("signature", "")

        # If the provider serves the same challenge again after a failed drag,
        # refresh the widget before reusing the previous vision estimate.
        if (
            signature
            and state.get("last_signature") == signature
            and state.get("last_success") is False
            and _refresh_captcha(driver)
        ):
            refreshed_assets = _extract_captcha_assets(driver)
            if refreshed_assets is not None:
                assets = refreshed_assets
                signature = assets.get("signature", signature)

        for vision_attempt in range(2):
            bg = assets["bg"]
            slc = assets["slice"]
            display_width = float(assets["display_width"] or 0)
            natural_width = int(bg.shape[1]) if bg is not None else 0

            distance_px, confidence = _estimate_distance(bg, slc)
            if distance_px is None:
                confidence = 0.0
                distance_px = -1
            elif display_width > 0 and natural_width > 0:
                distance_px = int(round(distance_px * (display_width / natural_width)))

            distance_offset = _env_int("CNKI_CAPTCHA_DISTANCE_OFFSET", -4)
            distance_px += distance_offset
            min_conf = _env_float("CNKI_CAPTCHA_MATCH_THRESHOLD", 0.38)
            print(
                f"Vision distance: {distance_px}px, confidence: {confidence:.3f}, "
                f"natural: {natural_width}px, css: {display_width:.1f}px"
            )
            if confidence >= min_conf and distance_px >= 10:
                break

            if vision_attempt == 0 and _refresh_captcha(driver):
                refreshed_assets = _extract_captcha_assets(driver)
                if refreshed_assets is not None:
                    assets = refreshed_assets
                    signature = assets.get("signature", signature)
                    continue

            print("Vision confidence too low or distance too short; skip this solve attempt.")
            state["last_signature"] = signature
            state["last_success"] = False
            return False

        handle = _slider_handle(driver)
        if not handle:
            print("Could not find slider handle in DOM.")
            with open("captcha_slider_dom.html", "w", encoding="utf-8") as f:
                f.write(driver.page_source)
            state["last_signature"] = signature
            state["last_success"] = False
            return False

        tracks = generate_human_tracks(distance_px)
        print("Dragging slider...")
        _perform_drag(driver, handle, tracks)
        print("Slider released.")
        time.sleep(_env_float("CNKI_CAPTCHA_POST_RELEASE_WAIT_SECONDS", 1.6))
        state["last_signature"] = signature
        if _captcha_still_active(driver, signature):
            print("Captcha is still active after drag; treat this round as failed.")
            state["last_success"] = False
            return False
        state["last_success"] = True
        return True
    except Exception:
        state = _session_state(driver)
        state["last_success"] = False
        return False


def solve_slider_captcha(driver, slider_container=None):
    del slider_container
    render_wait = _env_float("CNKI_CAPTCHA_RENDER_WAIT_SECONDS", 1.3)
    print(f"Initiating automated CAPTCHA slider solver (render wait {render_wait:.1f}s)...")
    time.sleep(render_wait)

    print("Attempting to solve in default context...")
    if attempt_solve_in_context(driver):
        return True

    print("Attempting to solve in iframes...")
    driver.switch_to.default_content()
    frames = driver.find_elements(By.TAG_NAME, "iframe")
    for frame in frames:
        try:
            driver.switch_to.frame(frame)
            if attempt_solve_in_context(driver):
                driver.switch_to.default_content()
                return True
        except Exception:
            pass
        finally:
            driver.switch_to.default_content()

    print("CAPTCHA solver could not locate images or handle in any frame.")
    artifacts = capture_page_artifacts(driver, "captcha-solver-miss")
    print(f"Captcha solver snapshot: {artifacts}")
    return False
