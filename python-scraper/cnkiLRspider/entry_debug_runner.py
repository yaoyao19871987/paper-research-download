from datetime import datetime

from cnki_common import build_driver, open_advanced_search, switch_search_mode


def write_log(message: str) -> None:
    with open("entry_debug.log", "a", encoding="utf-8") as handle:
        handle.write(f"{datetime.now().isoformat(timespec='seconds')} | {message}\n")


def main() -> None:
    write_log("start")
    driver = build_driver()
    write_log("driver_ready")
    try:
        open_advanced_search(driver)
        write_log(f"after_open_advanced_search url={driver.current_url}")
        switch_search_mode(driver, mode="professional")
        write_log(f"after_switch url={driver.current_url}")
        state = driver.execute_script(
            """
            const major = document.querySelector("li[name='majorSearch']");
            const txt = document.querySelector("textarea.textarea-major, textarea.majorSearch");
            const verifyFrame = Array.from(document.querySelectorAll('iframe'))
              .some(f => /verify|captcha/i.test((f.src || '') + ' ' + (f.id || '') + ' ' + (f.className || '')));
            return {
              majorActive: !!(major && /active/i.test(major.className || '')),
              textareaVisible: !!(txt && txt.offsetParent !== null),
              verifyFramePresent: verifyFrame,
              url: window.location.href,
            };
            """
        )
        write_log(f"state={state}")
    finally:
        driver.quit()
        write_log("quit")


if __name__ == "__main__":
    main()
