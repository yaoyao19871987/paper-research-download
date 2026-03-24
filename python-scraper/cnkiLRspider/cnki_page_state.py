import os
from datetime import datetime
from pathlib import Path
from typing import Dict


def get_page_state(driver) -> Dict[str, object]:
    try:
        return driver.execute_script(
            """
            const isVisible = (el) => !!(
              el &&
              ((el.offsetParent !== null) ||
               (el.getClientRects && el.getClientRects().length > 0))
            );
            const visibleCount = (selector) =>
              Array.from(document.querySelectorAll(selector)).filter(isVisible).length;
            const visibleMedia = Array.from(
              document.querySelectorAll('.verify-img-panel img, .verify-img-panel canvas, img, canvas')
            )
              .filter((el) => {
                if (!isVisible(el)) return false;
                const rect = el.getBoundingClientRect();
                return rect.width >= 30 && rect.height >= 30;
              })
              .map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                  width: rect.width,
                  height: rect.height,
                  area: rect.width * rect.height,
                };
              })
              .sort((a, b) => b.area - a.area);
            const major = document.querySelector("li[name='majorSearch']");
            const textarea = document.querySelector("textarea.textarea-major, textarea.majorSearch, textarea");
            const bodyText = ((document.body && document.body.innerText) || '').toLowerCase();
            const verifyFramePresent = Array.from(document.querySelectorAll('iframe')).some((frame) => {
              const text = ((frame.src || '') + ' ' + (frame.id || '') + ' ' + (frame.className || '')).toLowerCase();
              return isVisible(frame) && /verify|captcha/.test(text);
            });
            return {
              url: window.location.href,
              title: document.title || '',
              bodyTextSnippet: bodyText.slice(0, 2000),
              majorActive: !!(major && /active/i.test(major.className || '')),
              textareaVisible: !!(textarea && isVisible(textarea)),
              hasModeTabs: visibleCount("li[name='majorSearch'], li[name='gradeSearch']") > 0,
              hasSearchCore: visibleCount("input.btn-search, #gradetxt, textarea") > 0,
              hasSearchAnchor: visibleCount("#ModuleSearch, #txt_SearchText, #gradetxt, textarea, input.btn-search, button[class*='search']") > 0,
              captchaHandleVisible: visibleCount(".verify-move-block, .geetest_slider_button, .verify-slider-btn, .slider-btn, .yidun_slider") > 0,
              captchaInlineVisible: visibleCount(".verify-move-block, .verifybox, .geetest_slider_button, .yidun_slider, .verify-img-panel") > 0,
              verifyFramePresent,
              displayWidth: visibleMedia.length ? visibleMedia[0].width : 0,
              displayHeight: visibleMedia.length ? visibleMedia[0].height : 0,
            };
            """
        )
    except Exception:
        current_url = ""
        try:
            current_url = driver.current_url or ""
        except Exception:
            pass
        return {
            "url": current_url,
            "title": "",
            "bodyTextSnippet": "",
            "majorActive": False,
            "textareaVisible": False,
            "hasModeTabs": False,
            "hasSearchCore": False,
            "hasSearchAnchor": False,
            "captchaHandleVisible": False,
            "captchaInlineVisible": False,
            "verifyFramePresent": False,
            "displayWidth": 0,
            "displayHeight": 0,
        }


def page_has_visible_captcha(state: Dict[str, object]) -> bool:
    return bool(state.get("captchaInlineVisible") or state.get("verifyFramePresent"))


def page_ready_for_advanced_search(state: Dict[str, object]) -> bool:
    return bool(state.get("hasModeTabs") and state.get("hasSearchCore"))


def capture_page_artifacts(driver, label: str, *, output_dir: str = "outputs") -> Dict[str, str]:
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_label = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in label).strip("-") or "page"
    base = Path(output_dir) / f"{timestamp}-{safe_label}"
    screenshot_path = str(base.with_suffix(".png"))
    html_path = str(base.with_suffix(".html"))
    try:
        driver.save_screenshot(screenshot_path)
    except Exception:
        screenshot_path = ""
    try:
        html = driver.page_source
        Path(html_path).write_text(html, encoding="utf-8")
    except Exception:
        html_path = ""
    return {
        "screenshot": os.path.abspath(screenshot_path) if screenshot_path else "",
        "html": os.path.abspath(html_path) if html_path else "",
    }
