import os
import time
from typing import Optional, Sequence, Tuple
from urllib.parse import urlparse

from selenium.common.exceptions import (
    ElementClickInterceptedException,
    StaleElementReferenceException,
    TimeoutException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from cnki_captcha import solve_slider_captcha
from cnki_page_state import capture_page_artifacts, get_page_state, page_has_visible_captcha, page_ready_for_advanced_search

Locator = Tuple[str, str]

ADV_SEARCH_URL = "https://kns.cnki.net/kns8s/AdvSearch"


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _presence(driver, locators: Sequence[Locator], timeout_seconds: int = 8) -> Optional[WebElement]:
    for by, value in locators:
        try:
            return WebDriverWait(driver, timeout_seconds).until(
                EC.presence_of_element_located((by, value))
            )
        except TimeoutException:
            continue
    return None


def _clickable(driver, locators: Sequence[Locator], timeout_seconds: int = 8) -> Optional[WebElement]:
    for by, value in locators:
        try:
            return WebDriverWait(driver, timeout_seconds).until(
                EC.element_to_be_clickable((by, value))
            )
        except TimeoutException:
            continue
    return None


def _safe_click(driver, element: WebElement) -> None:
    try:
        element.click()
    except (ElementClickInterceptedException, StaleElementReferenceException):
        driver.execute_script("arguments[0].click();", element)


def _is_verification_blocked(driver, current_url: str = "", page_text: str = "") -> bool:
    parsed_url = urlparse(current_url or "")
    path = (parsed_url.path or "").lower()
    if "/verify" in path or "/captcha" in path:
        return True
    if "security verification" in page_text or "slide" in page_text:
        return True
    try:
        state = get_page_state(driver)
        return page_has_visible_captcha(state) or "security verification" in str(state.get("bodyTextSnippet", ""))
    except Exception:
        return False


def _search_anchor_present(driver) -> bool:
    anchor = _presence(
        driver,
        [
            (By.CSS_SELECTOR, "#ModuleSearch"),
            (By.CSS_SELECTOR, "#txt_SearchText"),
            (By.CSS_SELECTOR, "#gradetxt"),
            (By.CSS_SELECTOR, "textarea.textarea-major"),
            (By.CSS_SELECTOR, "textarea.majorSearch"),
            (By.CSS_SELECTOR, "input.btn-search"),
            (By.CSS_SELECTOR, "button[class*='search']"),
        ],
        timeout_seconds=2,
    )
    return anchor is not None


def advanced_search_ready(driver) -> bool:
    return page_ready_for_advanced_search(get_page_state(driver))


def wait_for_verification_to_clear(driver, timeout_seconds: int = 600) -> None:
    deadline = time.time() + timeout_seconds
    noticed = False
    last_wait_log_at = 0.0
    auto_solve = _env_bool("CNKI_CAPTCHA_AUTO_SOLVE", True)
    max_auto_attempts = _env_int("CNKI_CAPTCHA_AUTO_MAX_ATTEMPTS", 100)
    cooldown_seconds = _env_float("CNKI_CAPTCHA_AUTO_COOLDOWN_SECONDS", 0.8)
    settle_seconds = _env_float("CNKI_CAPTCHA_SETTLE_SECONDS", 1.0)
    poll_interval = _env_float("CNKI_VERIFY_POLL_INTERVAL_SECONDS", 0.5)
    auto_attempts = 0
    last_auto_attempt_at = 0.0
    no_ready_since = None

    while time.time() < deadline:
        state = get_page_state(driver)
        current_url = str(state.get("url", "")).lower()
        page_text = str(state.get("bodyTextSnippet", "")).lower()
        blocked = _is_verification_blocked(driver, current_url, page_text)

        if not blocked:
            if bool(state.get("hasSearchAnchor")) or _search_anchor_present(driver):
                if noticed:
                    print("CNKI security verification cleared. Continuing workflow...")
                return
            if no_ready_since is None:
                no_ready_since = time.time()
        else:
            no_ready_since = None

        stalled_without_ready = (
            no_ready_since is not None
            and (time.time() - no_ready_since) >= _env_float("CNKI_VERIFY_STALL_SOLVE_SECONDS", 1.5)
        )

        if (blocked or stalled_without_ready) and not noticed:
            print("CNKI security verification or entry stall detected.")
            noticed = True

        now = time.time()
        can_auto_attempt = (
            auto_solve
            and auto_attempts < max_auto_attempts
            and (now - last_auto_attempt_at) >= cooldown_seconds
            and (blocked or stalled_without_ready)
        )
        if can_auto_attempt:
            auto_attempts += 1
            last_auto_attempt_at = now
            print(f"Automated solver attempt {auto_attempts}/{max_auto_attempts}...")
            try:
                solved = bool(solve_slider_captcha(driver))
            except Exception as exc:
                solved = False
                print(f"Automated solver error: {exc}.")
            if solved:
                print("Automated solver finished one attempt. Waiting for page settle...")
                time.sleep(settle_seconds)
            else:
                print("Automated solver could not complete this round. Waiting for retry/manual action...")

        if time.time() - last_wait_log_at >= 15:
            print(
                "Still waiting for CNKI security verification... "
                f"url={state.get('url', '')} "
                f"captcha={page_has_visible_captcha(state)} "
                f"ready={page_ready_for_advanced_search(state)}"
            )
            last_wait_log_at = time.time()

        time.sleep(max(0.2, poll_interval))

    artifacts = capture_page_artifacts(driver, "verify-timeout")
    print(f"Verification wait timed out. Snapshot: {artifacts}")
    raise TimeoutException("Timed out waiting for CNKI verification to clear.")


def open_advanced_search(driver, *, pause_fn=None, adv_search_url: str = ADV_SEARCH_URL) -> None:
    print("Opening CNKI advanced search page directly...")
    max_attempts = _env_int("CNKI_ADV_ENTRY_MAX_ATTEMPTS", 6)
    verify_timeout = _env_int("CNKI_ADV_ENTRY_VERIFY_TIMEOUT", 30)

    for attempt in range(1, max_attempts + 1):
        if attempt == 1:
            driver.get(adv_search_url)
        else:
            print(f"Advanced page not ready yet, refreshing (attempt {attempt}/{max_attempts})...")
            try:
                driver.refresh()
            except Exception:
                driver.get(adv_search_url)

        if pause_fn is not None:
            pause_fn("after_nav")
        else:
            time.sleep(1.0)

        try:
            wait_for_verification_to_clear(driver, timeout_seconds=verify_timeout)
        except TimeoutException:
            artifacts = capture_page_artifacts(driver, f"adv-entry-timeout-attempt-{attempt}")
            print(f"Advanced entry attempt {attempt} timed out. Snapshot: {artifacts}")
            if attempt < max_attempts:
                continue
            raise
        if advanced_search_ready(driver):
            print("Advanced search page is ready.")
            return

    raise TimeoutException("Advanced search page did not become ready after retries.")


def switch_search_mode(driver, *, mode: str = "professional", pause_fn=None, adv_search_url: str = ADV_SEARCH_URL) -> None:
    if mode == "professional":
        mode_name = "majorSearch"
        target_url = f"{adv_search_url}?type=expert"
        ready_locator = (By.CSS_SELECTOR, "textarea.textarea-major, textarea.majorSearch")
    else:
        mode_name = "gradeSearch"
        target_url = adv_search_url
        ready_locator = (By.CSS_SELECTOR, ".grade-search-content, .gradeSearch")

    max_switch_attempts = _env_int("CNKI_MODE_SWITCH_MAX_ATTEMPTS", 5)
    for attempt in range(1, max_switch_attempts + 1):
        current_url = driver.current_url or ""
        if mode == "professional" and "type=expert" not in current_url:
            driver.get(target_url)
            wait_for_verification_to_clear(driver, timeout_seconds=_env_int("CNKI_VERIFY_TIMEOUT", 600))
        elif mode != "professional" and "type=expert" in current_url:
            driver.get(target_url)
            wait_for_verification_to_clear(driver, timeout_seconds=_env_int("CNKI_VERIFY_TIMEOUT", 600))

        tab = _clickable(
            driver,
            [
                (By.CSS_SELECTOR, f"li[name='{mode_name}']"),
                (By.XPATH, f"//li[@name='{mode_name}']"),
            ],
            timeout_seconds=4,
        )
        if tab is not None:
            _safe_click(driver, tab)
        elif mode == "professional":
            clicked = driver.execute_script(
                """
                const li = document.querySelector("li[name='majorSearch']");
                if (!li) return false;
                (li.querySelector('a') || li).click();
                return true;
                """
            )
            if not clicked:
                driver.get(target_url)
                wait_for_verification_to_clear(driver, timeout_seconds=_env_int("CNKI_VERIFY_TIMEOUT", 600))
        else:
            raise TimeoutException(f"Could not locate search mode tab: {mode_name}.")

        if pause_fn is not None:
            pause_fn("normal")
        else:
            time.sleep(1.0)

        try:
            WebDriverWait(driver, 8).until(EC.presence_of_element_located(ready_locator))
        except TimeoutException:
            if attempt < max_switch_attempts:
                print(
                    f"Search mode '{mode_name}' not ready yet. Refreshing and retrying ({attempt + 1}/{max_switch_attempts})..."
                )
                driver.refresh()
                wait_for_verification_to_clear(driver, timeout_seconds=_env_int("CNKI_VERIFY_TIMEOUT", 600))
                continue
            raise

        if mode != "professional":
            return

        is_active = driver.execute_script(
            """
            const li = document.querySelector("li[name='majorSearch']");
            const txt = document.querySelector("textarea.textarea-major, textarea.majorSearch");
            return !!(li && /active/i.test(li.className || '') && txt && txt.offsetParent !== null);
            """
        )
        if is_active:
            return

        if attempt < max_switch_attempts:
            print(
                f"Professional search tab click did not stick. Retrying ({attempt + 1}/{max_switch_attempts})..."
            )

    raise TimeoutException(f"Could not switch to search mode: {mode_name}.")
