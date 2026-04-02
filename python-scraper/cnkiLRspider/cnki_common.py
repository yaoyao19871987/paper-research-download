import hashlib
import json
import os
import random
import re
import socket
import time
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from selenium import webdriver
from selenium.common.exceptions import (
  ElementClickInterceptedException,
  NoSuchElementException,
  NoSuchWindowException,
  StaleElementReferenceException,
  TimeoutException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from cnki_entry import (
  advanced_search_ready as entry_advanced_search_ready,
  open_advanced_search as entry_open_advanced_search,
  switch_search_mode as entry_switch_search_mode,
  wait_for_verification_to_clear as entry_wait_for_verification_to_clear,
)

Locator = Tuple[str, str]

ADV_SEARCH_URL = "https://kns.cnki.net/kns8s/AdvSearch"
FIELD_CODE_TO_LABEL = {
  "SU": "subject",
  "TKA": "keyword_extended",
  "KY": "keyword",
  "TI": "title",
  "FT": "full_text",
  "AU": "author",
  "FI": "first_author",
  "RP": "corresponding_author",
  "AF": "author_affiliation",
  "FU": "fund",
  "AB": "abstract",
  "CO": "subtitle",
  "RF": "reference",
  "CLC": "classification",
  "LY": "source",
  "DOI": "DOI",
  "CF": "citation_count",
}
FIELD_LABEL_TO_CODE = {value: key for key, value in FIELD_CODE_TO_LABEL.items()}


def env_int(name: str, default: int) -> int:
  value = os.getenv(name)
  if value is None:
    return default
  try:
    return int(value)
  except ValueError:
    return default


def env_bool(name: str, default: bool = False) -> bool:
  value = os.getenv(name)
  if value is None:
    return default
  return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def env_float(name: str, default: float) -> float:
  value = os.getenv(name)
  if value is None:
    return default
  try:
    return float(value)
  except ValueError:
    return default


def human_sleep(min_seconds: float = 0.8, max_seconds: float = 2.0) -> None:
  if max_seconds < min_seconds:
    max_seconds = min_seconds
  time.sleep(random.uniform(min_seconds, max_seconds))


def human_pause(kind: str = "normal") -> None:
  """Predefined human-like delay presets."""
  presets = {
    "micro": (0.2, 0.6),
    "normal": (0.8, 2.0),
    "read": (1.5, 3.5),
    "think": (2.5, 5.0),
    "between_queries": (4.0, 9.0),
    "after_nav": (2.0, 4.0),
  }
  lo, hi = presets.get(kind, presets["normal"])
  human_sleep(lo, hi)


def _port_is_open(host: str, port: int, timeout_seconds: float = 0.35) -> bool:
  try:
    with socket.create_connection((host, port), timeout=timeout_seconds):
      return True
  except OSError:
    return False


def _detect_debugger_address() -> str:
  host = os.getenv("CNKI_DEBUGGER_HOST", "127.0.0.1").strip() or "127.0.0.1"
  configured_ports = os.getenv("CNKI_DEBUGGER_PORTS", "9222,9223,9333")
  for item in configured_ports.split(","):
    item = item.strip()
    if not item:
      continue
    try:
      port = int(item)
    except ValueError:
      continue
    if _port_is_open(host, port):
      return f"{host}:{port}"
  return ""


def build_driver() -> webdriver.Edge:
  browser = (os.getenv("CNKI_BROWSER", "chrome").strip().lower() or "chrome")
  debugger_address = os.getenv("CNKI_DEBUGGER_ADDRESS", "").strip()
  if not debugger_address and env_bool("CNKI_AUTO_ATTACH_DEBUGGER", True):
    debugger_address = _detect_debugger_address()
    if debugger_address:
      print(f"Auto-attaching to existing browser debugger at {debugger_address}.")

  if browser == "edge":
    options = webdriver.EdgeOptions()
    user_data_dir = os.getenv("CNKI_EDGE_USER_DATA_DIR", "").strip()
    profile_directory = os.getenv("CNKI_EDGE_PROFILE_DIRECTORY", "").strip()
    driver_factory = webdriver.Edge
  else:
    options = webdriver.ChromeOptions()
    user_data_dir = os.getenv("CNKI_CHROME_USER_DATA_DIR", "").strip()
    profile_directory = os.getenv("CNKI_CHROME_PROFILE_DIRECTORY", "").strip()
    driver_factory = webdriver.Chrome

  options.page_load_strategy = os.getenv("CNKI_PAGELOAD_STRATEGY", "eager").strip() or "eager"

  if debugger_address:
    options.add_experimental_option("debuggerAddress", debugger_address)
  else:
    if env_bool("CNKI_HEADLESS", False):
      options.add_argument("--headless=new")
    if user_data_dir:
      options.add_argument(f"--user-data-dir={user_data_dir}")
    if profile_directory:
      options.add_argument(f"--profile-directory={profile_directory}")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

  driver = driver_factory(options=options)
  driver.set_page_load_timeout(env_int("CNKI_PAGELOAD_TIMEOUT", 120))
  driver.implicitly_wait(1)
  return driver


def _presence(driver: webdriver.Edge, locators: Sequence[Locator], timeout_seconds: int = 8) -> Optional[WebElement]:
  for by, value in locators:
    try:
      return WebDriverWait(driver, timeout_seconds).until(
        EC.presence_of_element_located((by, value))
      )
    except TimeoutException:
      continue
  return None


def _clickable(driver: webdriver.Edge, locators: Sequence[Locator], timeout_seconds: int = 8) -> Optional[WebElement]:
  for by, value in locators:
    try:
      return WebDriverWait(driver, timeout_seconds).until(
        EC.element_to_be_clickable((by, value))
      )
    except TimeoutException:
      continue
  return None


def _is_verification_blocked(driver: webdriver.Edge, current_url: str, page_text: str) -> bool:
  parsed_url = urlparse(current_url)
  path = (parsed_url.path or "").lower()
  if "/verify" in path or "/captcha" in path:
    return True
  if "security verification" in page_text or "slide" in page_text:
    return True
  try:
    return bool(driver.execute_script(
      """
      const hasInline = !!(document.querySelector('.verify-move-block')
        || document.querySelector('.verifybox')
        || document.querySelector('.geetest_slider_button'));
      if (hasInline) return true;
      const hasVerifyFrame = Array.from(document.querySelectorAll('iframe'))
        .some(f => /verify|captcha/i.test((f.src || '') + ' ' + (f.id || '') + ' ' + (f.className || '')));
      if (hasVerifyFrame) return true;
      const title = (document.title || '').toLowerCase();
      return /verify|captcha/.test(title);
      """
    ))
  except Exception:
    return False


def _search_anchor_present(driver: webdriver.Edge) -> bool:
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


def _advanced_search_ready(driver: webdriver.Edge) -> bool:
  has_mode_tabs = bool(driver.find_elements(By.CSS_SELECTOR, "li[name='majorSearch'], li[name='gradeSearch']"))
  has_search_core = bool(driver.find_elements(By.CSS_SELECTOR, "input.btn-search, #gradetxt, textarea"))
  return has_mode_tabs and has_search_core


def _safe_click(driver: webdriver.Edge, element: WebElement) -> None:
  try:
    element.click()
  except ElementClickInterceptedException:
    driver.execute_script("arguments[0].click();", element)


def _click_locators(
  driver: webdriver.Edge,
  locators: Sequence[Locator],
  timeout_seconds: int = 8,
  retries: int = 3,
  settle_pause: str = "micro",
) -> bool:
  for attempt in range(retries):
    element = _clickable(driver, locators, timeout_seconds=timeout_seconds)
    if element is None:
      return False

    try:
      _safe_click(driver, element)
      if settle_pause:
        human_pause(settle_pause)
      return True
    except StaleElementReferenceException:
      if attempt >= retries - 1:
        raise
      human_sleep(0.2, 0.5)

  return False


def wait_for_verification_to_clear(driver: webdriver.Edge, timeout_seconds: int = 600) -> None:
  return entry_wait_for_verification_to_clear(driver, timeout_seconds=timeout_seconds)


def open_advanced_search(driver: webdriver.Edge) -> None:
  return entry_open_advanced_search(driver, pause_fn=human_pause, adv_search_url=ADV_SEARCH_URL)


def _find_visible_textarea(driver: webdriver.Edge, timeout_seconds: int = 6) -> Optional[WebElement]:
  _presence(
    driver,
    [
      (By.CSS_SELECTOR, "textarea.textarea-major"),
      (By.CSS_SELECTOR, "textarea.majorSearch"),
      (By.CSS_SELECTOR, "textarea"),
      (By.XPATH, "//textarea"),
    ],
    timeout_seconds=timeout_seconds,
  )

  candidates = driver.find_elements(By.CSS_SELECTOR, "textarea.textarea-major, textarea.majorSearch, textarea")
  for element in candidates:
    try:
      if element.is_displayed() and element.is_enabled():
        return element
    except StaleElementReferenceException:
      continue
  return None


def _clear_textarea(driver: webdriver.Edge, textarea: WebElement) -> None:
  driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", textarea)
  try:
    textarea.click()
  except Exception:
    driver.execute_script("arguments[0].click();", textarea)
  try:
    textarea.send_keys(Keys.CONTROL, "a")
    textarea.send_keys(Keys.BACKSPACE)
  except Exception:
    driver.execute_script("arguments[0].value = '';", textarea)


def navigate_to_search(driver: webdriver.Edge, is_first_query: bool = True) -> bool:
  """
  Navigate to CNKI advanced search in professional-search mode.
  Returns True when the caller should perform one-time result-page setup.
  """
  if is_first_query:
    open_advanced_search(driver)
    switch_search_mode(driver, mode="professional")
    return True

  human_pause("between_queries")
  current_url = (driver.current_url or "")
  on_professional_search_page = "AdvSearch" in current_url and "type=expert" in current_url

  if on_professional_search_page:
    textarea = _find_visible_textarea(driver, timeout_seconds=4)
    if textarea is not None:
      _clear_textarea(driver, textarea)
      human_pause("micro")
      return False

  driver.get(f"{ADV_SEARCH_URL}?type=expert")
  wait_for_verification_to_clear(driver, timeout_seconds=env_int("CNKI_VERIFY_TIMEOUT", 600))
  # _ensure_journal_database(driver)
  human_pause("after_nav")
  return False


def _ensure_journal_database(driver: webdriver.Edge) -> None:
  journal_tab = _clickable(
    driver,
    [
      (By.XPATH, "//a[contains(.,'瀛︽湳鏈熷垔')]"),
      (By.XPATH, "//*[@id='txt_databases']//a[contains(.,'瀛︽湳鏈熷垔')]"),
    ],
    timeout_seconds=6,
  )
  if journal_tab is not None:
    _safe_click(driver, journal_tab)
    human_pause("micro")


def switch_search_mode(driver: webdriver.Edge, mode: str = "professional") -> None:
  return entry_switch_search_mode(
    driver,
    mode=mode,
    pause_fn=human_pause,
    adv_search_url=ADV_SEARCH_URL,
  )


def _set_checkbox_state(driver: webdriver.Edge, label_text: str, checked: bool) -> None:
  labels = driver.find_elements(By.XPATH, f"//*[contains(normalize-space(.),'{label_text}')]")
  for label in labels:
    try:
      checkbox = label.find_element(By.XPATH, ".//input[@type='checkbox']")
      is_checked = checkbox.is_selected()
      if is_checked != checked:
        _safe_click(driver, label)
        human_pause("micro")
      return
    except (NoSuchElementException, StaleElementReferenceException):
      continue


def set_precision_toggles(driver: webdriver.Edge) -> None:
  # Precision toggles are best-effort because CNKI labels may vary by locale/encoding.
  for label in ("中英文扩展", "同义词扩展", "English Expansion", "Synonym Expansion"):
    try:
      _set_checkbox_state(driver, label, False)
    except Exception:
      continue


def clear_advanced_conditions(driver: webdriver.Edge) -> None:
  reset_button = _clickable(
    driver,
    [
      (By.XPATH, "//a[contains(.,'閲嶇疆鏉′欢')]"),
      (By.XPATH, "//button[contains(.,'閲嶇疆鏉′欢')]"),
    ],
    timeout_seconds=3,
  )
  if reset_button is not None:
    _safe_click(driver, reset_button)
    human_sleep(0.5, 0.9)


def fill_professional_query(driver: webdriver.Edge, expression: str) -> None:
  textarea = _find_visible_textarea(driver, timeout_seconds=6)
  if textarea is None:
    raise NoSuchElementException("Could not find professional search textarea.")

  _clear_textarea(driver, textarea)
  human_sleep(0.3, 0.5)
  textarea.send_keys(expression)
  human_sleep(0.4, 0.8)


def _ensure_advanced_row_count(driver: webdriver.Edge, row_count: int) -> None:
  dd_items = driver.find_elements(By.CSS_SELECTOR, "#gradetxt dd")
  while len(dd_items) < row_count:
    plus_button = _clickable(
      driver,
      [
        (By.XPATH, "//*[@id='gradetxt']//a[normalize-space()='+']"),
      ],
      timeout_seconds=3,
    )
    if plus_button is None:
      raise NoSuchElementException("Could not add more advanced-search condition rows.")
    _safe_click(driver, plus_button)
    human_sleep(0.4, 0.8)
    dd_items = driver.find_elements(By.CSS_SELECTOR, "#gradetxt dd")


def _select_from_dropdown(container: WebElement, visible_text: str) -> None:
  trigger = container.find_element(By.CSS_SELECTOR, ".sort-default")
  trigger.click()
  human_sleep(0.2, 0.4)
  option = container.find_element(By.XPATH, f".//*[self::a or self::li or self::span][contains(normalize-space(.),'{visible_text}')]")
  option.click()


def fill_advanced_conditions(driver: webdriver.Edge, conditions: Sequence[Dict[str, str]]) -> None:
  clear_advanced_conditions(driver)
  if not conditions:
    raise ValueError("Advanced-search conditions cannot be empty.")

  _ensure_advanced_row_count(driver, len(conditions))
  dd_items = driver.find_elements(By.CSS_SELECTOR, "#gradetxt dd")

  for index, condition in enumerate(conditions):
    dd = dd_items[index]
    field_label = condition["field"]
    expression = condition["expression"]

    if index > 0:
      operator = condition.get("operator", "AND")
      logical_box = dd.find_element(By.CSS_SELECTOR, ".sort.logical")
      _select_from_dropdown(logical_box, operator)

    reopt_box = dd.find_element(By.CSS_SELECTOR, ".sort.reopt")
    _select_from_dropdown(reopt_box, field_label)
    input_box = dd.find_element(By.XPATH, ".//input[@type='text']")
    input_box.click()
    input_box.send_keys(Keys.CONTROL, "a")
    input_box.send_keys(Keys.BACKSPACE)
    human_sleep(0.2, 0.4)
    input_box.send_keys(expression)
    human_sleep(0.2, 0.4)


def submit_search(driver: webdriver.Edge) -> None:
  search_button_locators = [
    (By.CSS_SELECTOR, "input.btn-search"),
    (By.CSS_SELECTOR, "button.btn-search"),
    (By.CSS_SELECTOR, "button[class*='search']"),
    (By.CSS_SELECTOR, "input[type='button'][value*='检索']"),
  ]
  search_button = _clickable(driver, search_button_locators, timeout_seconds=6)
  if search_button is None:
    raise NoSuchElementException("Could not find CNKI search button.")

  try:
    _safe_click(driver, search_button)
  except StaleElementReferenceException:
    if not _click_locators(driver, search_button_locators, timeout_seconds=6, retries=3, settle_pause=""):
      raise NoSuchElementException("Could not find CNKI search button.")
  wait_for_verification_to_clear(driver, timeout_seconds=env_int("CNKI_VERIFY_TIMEOUT", 600))
  _wait_for_results(driver, timeout_seconds=25)
  human_pause("read")


def _wait_for_results(driver: webdriver.Edge, timeout_seconds: int = 25) -> None:
  def results_ready(d: webdriver.Edge) -> bool:
    return any(
      [
        bool(d.find_elements(By.ID, "gridTable")),
        bool(d.find_elements(By.XPATH, "//*[@id='gridTable']//dl/dd")),
        bool(d.find_elements(By.XPATH, "//*[@id='gridTable']//table/tbody/tr")),
        bool(d.find_elements(By.XPATH, "//*[contains(@class,'result-table-list')]")),
      ]
    )

  WebDriverWait(driver, timeout_seconds).until(results_ready)


def _page_size_already_selected(driver: webdriver.Edge, page_size: int) -> bool:
  target = str(page_size)
  try:
    return bool(driver.execute_script(
      """
      const root = document.querySelector('#perPageDiv');
      if (!root) return false;
      const selected = root.querySelector('.sort-default, .active, .cur, [aria-selected="true"]');
      if (!selected) return false;
      return (selected.textContent || '').includes(arguments[0]);
      """,
      target,
    ))
  except Exception:
    return False


def set_page_size(driver: webdriver.Edge, page_size: int = 50) -> bool:
  if _page_size_already_selected(driver, page_size):
    return True

  trigger_locators = [
    (By.XPATH, "//*[@id='perPageDiv']//i"),
    (By.XPATH, "//*[@id='perPageDiv']//span"),
  ]
  if not _click_locators(driver, trigger_locators, timeout_seconds=4, retries=4):
    return False

  option_locators = [
    (By.XPATH, f"//*[@id='perPageDiv']//a[normalize-space()='{page_size}']"),
    (By.XPATH, f"//*[@id='perPageDiv']//li[contains(.,'{page_size}')]//a"),
  ]
  if not _click_locators(driver, option_locators, timeout_seconds=4, retries=4, settle_pause=""):
    return False

  WebDriverWait(driver, 8).until(lambda d: _page_size_already_selected(d, page_size))
  human_pause("read")
  return True


def switch_to_detail_view(driver: webdriver.Edge) -> bool:
  detail_view_locators = [
    (By.XPATH, "//*[@id='gridTable']//li[contains(.,'璇︽儏')]"),
    (By.XPATH, "//li[contains(@class,'detail')]"),
    (By.XPATH, "//i[contains(@class,'icon-detail')]"),
  ]
  if not _click_locators(driver, detail_view_locators, timeout_seconds=4, retries=3, settle_pause=""):
    return False
  human_sleep(0.6, 1.0)
  return True


def set_result_sort(driver: webdriver.Edge, sort_mode: str) -> bool:
  # Prefer stable DOM ids from CNKI result page:
  # PT=publish time (default), CF=cited, DFR=download.
  sort_id_candidates = {
    "default": ["PT", "FFD", "ZH"],
    "cited": ["CF"],
    "download": ["DFR"],
  }.get(sort_mode, [])

  for sort_id in sort_id_candidates:
    try:
      item = driver.find_element(By.CSS_SELECTOR, f"#orderList li#{sort_id}")
    except Exception:
      item = None
    if item is None:
      continue

    css_class = (item.get_attribute("class") or "").lower()
    if "cur" not in css_class:
      _safe_click(driver, item)
      human_sleep(0.8, 1.4)
    return True

  # Fallback for pages where orderList is missing or layout changes.
  # Keep the crawl alive instead of failing the whole run.
  print(f"Sort control for '{sort_mode}' not found; continue with current order.")
  return True


def next_page(driver: webdriver.Edge) -> bool:
  wait_for_verification_to_clear(driver, timeout_seconds=env_int("CNKI_VERIFY_TIMEOUT", 600))
  button = _clickable(
    driver,
    [
      (By.ID, "PageNext"),
      (By.CSS_SELECTOR, "a#PageNext"),
      (By.CSS_SELECTOR, "a.next, button.next"),
    ],
    timeout_seconds=3,
  )
  if button is None:
    return False

  css_class = (button.get_attribute("class") or "").lower()
  if "disabled" in css_class:
    return False

  _safe_click(driver, button)
  human_pause("read")
  return True


def _pick_text(scope: WebElement, xpaths: Sequence[str]) -> str:
  driver = scope.parent
  driver.implicitly_wait(0)
  try:
    for xpath in xpaths:
      try:
        element = scope.find_element(By.XPATH, xpath)
        text = element.text.strip()
        if text:
          return text
      except (NoSuchElementException, StaleElementReferenceException):
        continue
  finally:
    driver.implicitly_wait(1)
  return ""


def _pick_attr(scope: WebElement, xpaths: Sequence[str], attr: str) -> str:
  driver = scope.parent
  driver.implicitly_wait(0)
  try:
    for xpath in xpaths:
      try:
        element = scope.find_element(By.XPATH, xpath)
        value = (element.get_attribute(attr) or "").strip()
        if value:
          return value
      except NoSuchElementException:
        continue
  finally:
    driver.implicitly_wait(1)
  return ""


def _join_text(scope: WebElement, xpaths: Sequence[str], separator: str = "; ") -> str:
  driver = scope.parent
  driver.implicitly_wait(0)
  try:
    for xpath in xpaths:
      try:
        elements = scope.find_elements(By.XPATH, xpath)
        values = [item.text.strip() for item in elements if item.text.strip()]
      except StaleElementReferenceException:
        continue
      if values:
        return separator.join(values)
  finally:
    driver.implicitly_wait(1)
  return ""


def _to_int(text: str) -> int:
  if not text:
    return 0
  digits = re.findall(r"\d+", text.replace(",", ""))
  return int(digits[0]) if digits else 0


def _extract_year(text: str) -> str:
  match = re.search(r"(19|20)\d{2}", text)
  return match.group(0) if match else ""


def normalize_detail_url(url: str) -> str:
  if not url:
    return ""
  parsed = urlparse(url)
  keep_keys = {
    "dbname",
    "filename",
    "dbcode",
    "tablename",
    "name",
    "v",
    "cid",
    "id",
    "articleid",
    "uniplatform",
    "language",
  }
  query = parse_qs(parsed.query)
  normalized_query = {key: value for key, value in query.items() if key.lower() in keep_keys}
  return urlunparse(
    (
      parsed.scheme,
      parsed.netloc,
      parsed.path,
      "",
      urlencode(sorted(normalized_query.items()), doseq=True),
      "",
    )
  )


def build_paper_identity(detail_url: str, title: str) -> Dict[str, str]:
  normalized_url = normalize_detail_url(detail_url)
  db_code = ""
  file_name = ""

  if normalized_url:
    query = parse_qs(urlparse(normalized_url).query)
    db_code = (query.get("dbcode") or query.get("dbname") or [""])[0]
    file_name = (query.get("filename") or query.get("name") or [""])[0]

  if db_code and file_name:
    paper_id = f"{db_code}{file_name}"
  elif normalized_url:
    paper_id = "url_" + hashlib.sha1(normalized_url.encode("utf-8")).hexdigest()[:20]
  else:
    title_key = re.sub(r"\s+", "", title or "")
    paper_id = "title_" + hashlib.sha1(title_key.encode("utf-8")).hexdigest()[:20]

  return {
    "paper_id": paper_id,
    "db_code": db_code,
    "file_name": file_name,
    "page_url": normalized_url or detail_url,
  }


def _normalize_inline_text(text: str) -> str:
  return re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()


def _pick_page_text(driver: webdriver.Edge, xpaths: Sequence[str]) -> str:
  for xpath in xpaths:
    try:
      elements = driver.find_elements(By.XPATH, xpath)
    except Exception:
      continue
    for element in elements:
      try:
        text = _normalize_inline_text(element.text)
      except StaleElementReferenceException:
        continue
      if text:
        return text
  return ""


def _pick_page_texts(driver: webdriver.Edge, xpaths: Sequence[str]) -> List[str]:
  for xpath in xpaths:
    values: List[str] = []
    try:
      elements = driver.find_elements(By.XPATH, xpath)
    except Exception:
      continue
    for element in elements:
      try:
        text = _normalize_inline_text(element.text)
      except StaleElementReferenceException:
        continue
      if text and text not in values:
        values.append(text)
    if values:
      return values
  return []


def _clean_abstract_text(text: str) -> str:
  cleaned = _normalize_inline_text(text)
  cleaned = re.sub(r"^鎽樿[:锛歖?\s*", "", cleaned)
  cleaned = re.sub(r"\s*(鏇村|杩樺師)\s*$", "", cleaned)
  cleaned = re.sub(r"AbstractFilter\(.*$", "", cleaned)
  return cleaned.strip()


def extract_detail_metadata(driver: webdriver.Edge) -> Dict[str, str]:
  wait_for_verification_to_clear(driver, timeout_seconds=env_int("CNKI_VERIFY_TIMEOUT", 600))
  WebDriverWait(driver, 12).until(
    lambda d: bool(
      d.find_elements(By.XPATH, "//h1[normalize-space() and not(contains(.,'鑷姩鐧诲綍')) and not(contains(.,'鎵惧洖瀵嗙爜'))]")
      or d.find_elements(By.XPATH, "//div[contains(@class,'row')][.//span[contains(@class,'rowtit') and contains(normalize-space(.),'鎽樿')]]")
    )
  )

  title = _pick_page_text(
    driver,
    [
      "//h1[normalize-space() and not(contains(.,'鑷姩鐧诲綍')) and not(contains(.,'鎵惧洖瀵嗙爜'))]",
      "//div[contains(@class,'doc')]//h1[normalize-space()]",
    ],
  )
  people = _pick_page_texts(
    driver,
    [
      "//h3[contains(@class,'author')]",
      "//h3[contains(@class,'author')]//a",
    ],
  )
  authors = people[0] if people else ""
  institution = "; ".join(people[1:]) if len(people) > 1 else ""
  journal = _pick_page_text(
    driver,
    [
      "//a[contains(@href,'/knavi/detail')][1]",
    ],
  )
  meta_block = _pick_page_text(
    driver,
    [
      "//div[contains(@class,'doc')]",
      "//div[contains(@class,'container')]//div[contains(@class,'doc')]",
    ],
  )
  abstract_block = _pick_page_text(
    driver,
    [
      "//div[contains(@class,'row')][.//span[contains(@class,'rowtit') and contains(normalize-space(.),'鎽樿')]]",
      "//*[contains(normalize-space(.), '鎽樿锛?) and string-length(normalize-space(.)) > 8]",
    ],
  )
  abstract = _clean_abstract_text(abstract_block)

  metadata = {
    "title": title,
    "authors": authors,
    "journal": journal,
    "publish_year": _extract_year(meta_block),
    "institution": institution,
    "abstract": abstract,
  }
  return {key: value for key, value in metadata.items() if value}


def fetch_detail_metadata(driver: webdriver.Edge, detail_url: str) -> Dict[str, str]:
  detail_url = normalize_detail_url(detail_url) or detail_url
  if not detail_url:
    return {}

  original_handle = driver.current_window_handle
  detail_handle = None
  try:
    driver.switch_to.new_window("tab")
    detail_handle = driver.current_window_handle
    try:
      driver.get(detail_url)
    except TimeoutException:
      try:
        driver.execute_script("window.stop();")
      except Exception:
        pass
    human_pause("read")
    metadata = extract_detail_metadata(driver)
    identity = build_paper_identity(detail_url, metadata.get("title", ""))
    metadata.update({key: value for key, value in identity.items() if value and not metadata.get(key)})
    if not metadata.get("page_url"):
      metadata["page_url"] = detail_url
    return metadata
  finally:
    if detail_handle:
      try:
        driver.close()
      except Exception:
        pass
    try:
      driver.switch_to.window(original_handle)
    except Exception:
      handles = driver.window_handles
      if handles:
        driver.switch_to.window(handles[0])

def _collect_result_cards(driver: webdriver.Edge, card_xpaths: Sequence[str]) -> List[WebElement]:
  for xpath in card_xpaths:
    cards = driver.find_elements(By.XPATH, xpath)
    if cards:
      return cards
  return []


def _extract_card_row(card: WebElement) -> Optional[Dict[str, str]]:
  title = _pick_text(
    card,
    [
      ".//td[contains(@class,'name')]//a[contains(@href,'article/abstract')]",
      ".//td[contains(@class,'name')]//a",
      ".//h6/a",
      ".//h6",
      ".//a[contains(@href,'article/abstract')]",
    ],
  )
  if not title:
    return None

  detail_url = _pick_attr(
    card,
    [
      ".//td[contains(@class,'name')]//a[contains(@href,'article/abstract')]",
      ".//td[contains(@class,'name')]//a",
      ".//h6/a",
      ".//a[contains(@href,'article/abstract')]",
    ],
    "href",
  )
  meta_text = card.text
  abstract = _pick_text(
    card,
    [
      ".//p[contains(@class,'abstract')]",
      ".//p[3]",
    ],
  )
  authors = _join_text(
    card,
    [
      ".//td[contains(@class,'author')]//a",
      ".//div[contains(@class,'author')]//a",
      ".//p//a[contains(@href,'/author/detail')]",
    ],
  )
  institution = _join_text(
    card,
    [
      ".//div[contains(@class,'source')]//span/a",
      ".//p//span/a",
    ],
  )
  journal = _pick_text(
    card,
    [
      ".//td[contains(@class,'source')]//a",
      ".//td[contains(@class,'source')]",
      ".//a[contains(@href,'/knavi/detail')]",
      ".//p[1]/span[1]/a",
    ],
  )
  issue_text = _pick_text(card, [".//td[contains(@class,'date')]"]) or meta_text
  cited_count = 0
  download_count = 0

  cited_match = re.search(r"(\d+)", _pick_text(card, [".//td[contains(@class,'quote')]", ".//a[contains(@class,'quote')]"]) or "")
  if cited_match:
    cited_count = int(cited_match.group(1))
  download_match = re.search(
    r"(\d+)",
    _pick_text(card, [".//td[contains(@class,'download')]", ".//a[contains(@class,'downloadCnt')]"]) or "",
  )
  if download_match:
    download_count = int(download_match.group(1))

  identity = build_paper_identity(detail_url, title)
  return {
    **identity,
    "title": title,
    "authors": authors,
    "journal": journal,
    "publish_year": _extract_year(issue_text or meta_text),
    "cited_count": str(cited_count),
    "download_count": str(download_count),
    "institution": institution,
    "abstract": abstract,
  }


def extract_result_cards(driver: webdriver.Edge) -> List[Dict[str, str]]:
  wait_for_verification_to_clear(driver, timeout_seconds=env_int("CNKI_VERIFY_TIMEOUT", 600))
  card_xpaths = [
    "//*[@id='gridTable']//table[contains(@class,'result-table-list')]//tbody/tr",
    "//*[@id='gridTable']//dl/dd",
    "//*[contains(@class,'result-table-list')]//dl/dd",
    "//dd[.//h6 or .//a[contains(@href,'article/abstract')]]",
  ]

  for attempt in range(3):
    rows: List[Dict[str, str]] = []
    saw_stale = False
    cards = _collect_result_cards(driver, card_xpaths)
    for index in range(len(cards)):
      try:
        current_cards = _collect_result_cards(driver, card_xpaths)
        if index >= len(current_cards):
          break
        row = _extract_card_row(current_cards[index])
      except StaleElementReferenceException:
        saw_stale = True
        break
      if row:
        rows.append(row)
    if rows or not saw_stale:
      return rows
    print(f"CNKI result list refreshed mid-read; retrying card extraction ({attempt + 1}/3)...")
    human_sleep(0.6, 1.0)
    wait_for_verification_to_clear(driver, timeout_seconds=env_int("CNKI_VERIFY_TIMEOUT", 600))

  return []


def detect_waiting_state(driver: webdriver.Edge) -> Dict[str, bool]:
  current_url = (driver.current_url or "").lower()
  page_text = driver.page_source[:2000].lower()
  return {
    "waiting_for_verification": "verify" in current_url or "瀹夊叏楠岃瘉" in page_text or "鎷煎浘" in page_text,
    "waiting_for_results": not bool(driver.find_elements(By.ID, "gridTable")),
  }


def dump_debug_html(driver: webdriver.Edge, path: str) -> None:
  with open(path, "w", encoding="utf-8") as handle:
    try:
      handle.write(driver.page_source)
    except (NoSuchWindowException, TimeoutException):
      handle.write("<!-- debug page unavailable: driver window was already closed or timed out -->\n")


def save_snapshot_json(path: str, payload: Dict[str, object]) -> None:
  with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)


def open_search_results(driver: webdriver.Edge, keyword: str) -> None:
  # Backward-compatible helper for the older scripts.
  expression = f"TKA=('{keyword}')"
  open_advanced_search(driver)
  switch_search_mode(driver, mode="professional")
  set_precision_toggles(driver)
  fill_professional_query(driver, expression)
  submit_search(driver)


def extract_detail_rows(driver: webdriver.Edge) -> List[Dict[str, str]]:
  return extract_result_cards(driver)


def extract_table_rows(driver: webdriver.Edge) -> List[Dict[str, str]]:
  return extract_result_cards(driver)
