import time

from cnki_common import (
    build_driver,
    fill_professional_query,
    open_advanced_search,
    submit_search,
    switch_search_mode,
    wait_for_verification_to_clear,
)


def get_standalone_driver():
    driver = build_driver()
    driver.set_page_load_timeout(30)
    return driver


def test_captcha_isolation():
    driver = get_standalone_driver()
    try:
        print(">>> Opening CNKI and entering advanced search...")
        open_advanced_search(driver)
        switch_search_mode(driver, mode="professional")

        print(">>> Page ready. Running repeated searches to observe verification behavior...")
        for i in range(1, 20):
            print(f"\n--- Search burst #{i} ---")
            try:
                wait_for_verification_to_clear(driver, timeout_seconds=5)
                fill_professional_query(driver, f"大语言模型测试 {i}")
                submit_search(driver)

                print(">>> Search submitted; checking verification status...")
                time.sleep(1.2)
                wait_for_verification_to_clear(driver, timeout_seconds=30)
            except Exception as e:
                print(f"Unexpected state during burst loop: {e}")
                wait_for_verification_to_clear(driver, timeout_seconds=30)
                break
    finally:
        print(">>> Test complete. Closing browser...")
        driver.quit()


if __name__ == "__main__":
    test_captcha_isolation()
