import os
import time

import numpy as np
import pyautogui
from PIL import Image

import config
from utils import wait_and_click, wait_for_image
from schedule_capture import capture_schedule
from navigator import (
    pass_warning_screen,
    pass_splash_screen,
    click_to_the_trains,
    click_choose_a_route,
    wait_for_route_screen,
    select_route,
    click_timetable,
    select_train_class,
    click_train,
)


def get_visible_service_boxes():
    """Calculate the positions of visible service boxes in the scroll area."""
    boxes = []
    y = config.SERVICE_LIST_TOP
    while y + config.SERVICE_BOX_HEIGHT <= config.SERVICE_LIST_BOTTOM:
        center_x = (config.SERVICE_LIST_LEFT + config.SERVICE_LIST_RIGHT) // 2
        center_y = y + config.SERVICE_BOX_HEIGHT // 2
        boxes.append((center_x, center_y))
        y += config.SERVICE_BOX_STRIDE
    return boxes


def screenshot_service_box(output_dir, y_center):
    """Take a screenshot of a service box, using border color to find exact edges.

    Grabs an oversized region around the expected position, then scans the left
    edge for the #57a6d0 border color to crop to the actual box boundaries.
    Falls back to the full grab if detection fails.
    Saves as service.png inside output_dir.
    """
    padding = 30
    grab_left = config.SERVICE_LIST_LEFT
    grab_top = y_center - config.SERVICE_BOX_HEIGHT // 2 - padding
    grab_width = config.SERVICE_LIST_RIGHT - config.SERVICE_LIST_LEFT + 10
    grab_height = config.SERVICE_BOX_HEIGHT + 2 * padding

    screenshot = pyautogui.screenshot(region=(grab_left, grab_top, grab_width, grab_height))
    img = np.array(screenshot)  # RGB

    # Scan a strip along the left edge for the border color
    target = np.array(config.SERVICE_BOX_BORDER_RGB)
    tol = config.SERVICE_BOX_COLOR_TOLERANCE
    strip = img[:, :5, :].astype(int)
    match = np.all(np.abs(strip - target) <= tol, axis=2)
    row_match = np.any(match, axis=1)

    # Find contiguous runs of matching rows
    runs = []
    in_run = False
    run_start = 0
    for r in range(len(row_match)):
        if row_match[r] and not in_run:
            run_start = r
            in_run = True
        elif not row_match[r] and in_run:
            runs.append((run_start, r))
            in_run = False
    if in_run:
        runs.append((run_start, len(row_match)))

    if runs:
        # Pick the run whose center is closest to the expected center
        expected_center = padding + config.SERVICE_BOX_HEIGHT // 2
        best_run = min(runs, key=lambda r: abs((r[0] + r[1]) / 2 - expected_center))
        top, bottom = best_run
        img = img[top:bottom, :, :]

    result = Image.fromarray(img)
    path = os.path.join(output_dir, "1_service.png")
    result.save(path)
    return path


def click_service_box(x, y):
    """Click on a service box, then press Enter twice to load the level."""
    pyautogui.moveTo(x, y)
    time.sleep(0.5)
    pyautogui.mouseDown()
    time.sleep(0.2)
    pyautogui.mouseUp()
    time.sleep(1.5)           # give game time to highlight/select the box
    pyautogui.press("enter")
    time.sleep(1.0)
    pyautogui.press("enter")


def _check_for_level_screen():
    """Check once for driver selection or get_started screen.

    Returns 'driver' if driver screen found (and clicks it),
    'get_started' if get_started screen found, or None if neither.
    """
    # Try each driver reference image
    for driver_ref in (config.REF_DRIVER, config.REF_DRIVER_1):
        if not os.path.isfile(driver_ref):
            continue
        try:
            driver_loc = pyautogui.locateOnScreen(driver_ref, confidence=config.CONFIDENCE)
            if driver_loc is not None:
                print(f"       Driver selection detected via '{os.path.basename(driver_ref)}' — clicking...")
                center = pyautogui.center(driver_loc)
                pyautogui.moveTo(center)
                time.sleep(0.5)
                pyautogui.mouseDown()
                time.sleep(0.2)
                pyautogui.mouseUp()
                time.sleep(config.CLICK_SETTLE_DELAY)
                return "driver"
        except pyautogui.ImageNotFoundException:
            pass

    # Try each get_started reference image
    for started_ref in (config.REF_GET_STARTED, config.REF_GET_STARTED_2):
        if not os.path.isfile(started_ref):
            continue
        try:
            started_loc = pyautogui.locateOnScreen(started_ref, confidence=config.CONFIDENCE)
            if started_loc is not None:
                return "get_started"
        except pyautogui.ImageNotFoundException:
            pass

    return None


def wait_for_level_load(click_x=None, click_y=None):
    """Wait for the level to load, handle optional driver selection, then get past 'Get Started'.

    If click coordinates are provided, retries the service box click up to RETRY_MAX times
    (waiting RETRY_WAIT seconds between attempts) if the level doesn't load.
    """
    print("       Waiting for level to load...")

    for attempt in range(1, config.RETRY_MAX + 1):
        # Wait RETRY_WAIT seconds for either driver or get_started screen
        start = time.time()
        found = None
        while time.time() - start < config.RETRY_WAIT:
            found = _check_for_level_screen()
            if found is not None:
                break
            time.sleep(1.0)

        if found is not None:
            break

        # Screen hasn't changed — retry the click if we have coordinates
        if attempt < config.RETRY_MAX:
            if click_x is not None and click_y is not None:
                print(f"       Screen hasn't changed (attempt {attempt}/{config.RETRY_MAX}), "
                      f"clicking service at ({click_x}, {click_y}) again...")
                click_service_box(click_x, click_y)
            else:
                print(f"       Screen hasn't changed (attempt {attempt}/{config.RETRY_MAX}), "
                      f"waiting again...")
        else:
            raise TimeoutError("Timed out waiting for level to load after "
                               f"{config.RETRY_MAX} attempts")

    # Now wait for either get_started variant and click it
    print("       Waiting for 'Get Started' screen...")
    get_started_refs = [r for r in (config.REF_GET_STARTED, config.REF_GET_STARTED_2)
                        if os.path.isfile(r)]
    found_loc = None
    start = time.time()
    while time.time() - start < config.SCREEN_TIMEOUT:
        for ref in get_started_refs:
            try:
                loc = pyautogui.locateOnScreen(ref, confidence=config.CONFIDENCE)
                if loc is not None:
                    found_loc = loc
                    break
            except pyautogui.ImageNotFoundException:
                pass
        if found_loc is not None:
            break
        time.sleep(1.0)
    if found_loc is None:
        raise TimeoutError("Timed out waiting for 'Get Started' screen")

    # Click 'Get Started' with retry — re-click if it's still visible
    for click_attempt in range(1, config.RETRY_MAX + 1):
        print("       Level loaded — clicking 'Get Started'...")
        center = pyautogui.center(found_loc)
        pyautogui.moveTo(center)
        time.sleep(0.5)
        pyautogui.mouseDown()
        time.sleep(0.2)
        pyautogui.mouseUp()
        time.sleep(3.0)

        # Check if Get Started is still on screen
        still_visible = False
        for ref in get_started_refs:
            try:
                loc = pyautogui.locateOnScreen(ref, confidence=config.CONFIDENCE)
                if loc is not None:
                    still_visible = True
                    found_loc = loc
                    break
            except pyautogui.ImageNotFoundException:
                pass

        if not still_visible:
            break

        if click_attempt < config.RETRY_MAX:
            print(f"       'Get Started' still visible (attempt {click_attempt}/{config.RETRY_MAX}), "
                  f"clicking again...")
        else:
            print(f"       WARNING: 'Get Started' still visible after {config.RETRY_MAX} attempts")

    time.sleep(5.0)           # game needs time to transition into gameplay


def exit_to_main_menu():
    """Press Escape, find 'Exit to Main Menu', and press Enter twice."""
    print("       Pressing Escape...")
    pyautogui.press("escape")
    time.sleep(4.0)           # pause menu needs time to render

    print("       Clicking 'Exit to Main Menu'...")
    if not wait_and_click(config.REF_EXIT_TO_MAIN_MENU, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE):
        raise TimeoutError("Timed out waiting for 'Exit to Main Menu'")
    time.sleep(1.0)
    print("       Pressing Enter twice...")
    pyautogui.press("enter")
    time.sleep(0.5)
    pyautogui.press("enter")
    time.sleep(config.CLICK_SETTLE_DELAY)


def _count_visible_trains(img):
    """Count visible train entries by scanning the left edge for #dedede borders.

    Returns the number of distinct train entries visible in the image.
    """
    border_rgb = np.array([0xde, 0xde, 0xde])
    border_tol = 20
    min_entry_height = 40

    strip = img[:, :3, :].astype(int)
    match = np.all(np.abs(strip - border_rgb) <= border_tol, axis=2)
    row_has_border = np.any(match, axis=1)

    runs = []
    in_run = False
    run_start = 0
    for r in range(len(row_has_border)):
        if row_has_border[r] and not in_run:
            run_start = r
            in_run = True
        elif not row_has_border[r] and in_run:
            runs.append((run_start, r))
            in_run = False
    if in_run:
        runs.append((run_start, len(row_has_border)))

    return len([(s, e) for s, e in runs if (e - s) >= min_entry_height])


def count_trains():
    """Count the number of trains in the current train class scroll box.

    Detects visible trains from the first frame, then scrolls one box at
    a time until the list stops moving. Returns visible + scrolls.
    Scrolls back to the top when done.
    """
    print("       Counting trains...")

    def _capture():
        region = (config.TRAIN_BOX_LEFT, config.TRAIN_BOX_TOP,
                  config.TRAIN_BOX_WIDTH, config.TRAIN_BOX_HEIGHT)
        return np.array(pyautogui.screenshot(region=region))

    def _frames_match(a, b):
        if a.shape != b.shape:
            return False
        return np.mean(np.abs(a.astype(float) - b.astype(float))) < 5.0

    first_img = _capture()
    visible_count = _count_visible_trains(first_img)
    print(f"       Visible trains in first frame: {visible_count}")

    prev_img = first_img
    scrolls = 0
    center_x = config.TRAIN_BOX_LEFT + config.TRAIN_BOX_WIDTH // 2
    center_y = config.TRAIN_BOX_TOP + config.TRAIN_BOX_HEIGHT // 2

    for _ in range(30):
        pyautogui.moveTo(center_x, center_y)
        time.sleep(0.3)
        pyautogui.scroll(config.TRAIN_SCROLL_PER_BOX)
        time.sleep(1.0)

        curr_img = _capture()
        if _frames_match(prev_img, curr_img):
            break
        scrolls += 1
        prev_img = curr_img

    total = visible_count + scrolls

    # Scroll back to top
    if scrolls > 0:
        pyautogui.moveTo(center_x, center_y)
        time.sleep(0.3)
        pyautogui.scroll(-config.TRAIN_SCROLL_PER_BOX * scrolls)
        time.sleep(1.0)

    print(f"       Found {total} trains ({visible_count} visible + {scrolls} scrolls).")
    return total


def _return_to_main_menu_from_menus():
    """From any in-game menu screen, press Escape until we reach the main menu.

    Checks for the 'To The Trains' tile to confirm we're at the main menu.
    Used when we're at the service list or class selection and need to get
    back to the main menu (not from inside a level — use exit_to_main_menu for that).
    """
    for attempt in range(6):
        # Check if we're already at the main menu
        try:
            loc = pyautogui.locateOnScreen(config.REF_TO_THE_TRAINS, confidence=config.CONFIDENCE)
            if loc is not None:
                print("       At main menu.")
                return
        except pyautogui.ImageNotFoundException:
            pass

        print(f"       Pressing Escape (attempt {attempt + 1})...")
        pyautogui.press("escape")
        time.sleep(2.0)

    print("       WARNING: Could not confirm main menu after Escape presses")


def navigate_to_train_list():
    """Re-navigate from main menu back to the train list (skips warning/splash).

    Stops at the train selection screen — does NOT click a specific train.
    """
    print("       Re-navigating to train list...")
    click_to_the_trains()
    click_choose_a_route()
    wait_for_route_screen()
    select_route()
    click_timetable()
    select_train_class()
    print("       Back at train list.")


def navigate_to_service_list(train_index):
    """Re-navigate from main menu back to the service list for a specific train."""
    navigate_to_train_list()
    click_train(train_index)


def scroll_service_list_down():
    """Scroll the service list down by one full page."""
    center_x = (config.SERVICE_LIST_LEFT + config.SERVICE_LIST_RIGHT) // 2
    center_y = (config.SERVICE_LIST_TOP + config.SERVICE_LIST_BOTTOM) // 2
    pyautogui.moveTo(center_x, center_y)
    time.sleep(0.3)
    visible_count = len(get_visible_service_boxes())
    scroll_clicks = config.SCROLL_PER_BOX * (visible_count - 1)
    pyautogui.scroll(scroll_clicks)
    time.sleep(2.0)           # let scroll animation settle


def _service_is_duplicate(service_dir, prev_service_img):
    """Compare current service screenshot against the previous one.

    Returns True if they are nearly identical (duplicate from scroll drift).
    """
    if prev_service_img is None:
        return False
    curr_path = os.path.join(service_dir, "1_service.png")
    if not os.path.isfile(curr_path):
        return False
    curr_img = np.array(Image.open(curr_path))
    if curr_img.shape != prev_service_img.shape:
        return False
    diff = np.mean(np.abs(curr_img.astype(float) - prev_service_img.astype(float)))
    print(f"       Diff from previous service: {diff:.1f}")
    return diff < 5.0


def process_all_services(base_dir, train_index, max_services=None):
    """Iterate through services for one train, capture each timetable.

    Always returns with the game at the MAIN MENU (after exit_to_main_menu).

    Args:
        base_dir: Directory for this train's service folders (e.g. screenshots/train_01/).
        train_index: 0-based index of the current train (for re-navigation).
        max_services: Maximum services to capture (None = unlimited).
    """
    service_index = 0
    page = 0
    previous_screenshot = None
    prev_service_img = None

    while True:
        boxes = get_visible_service_boxes()
        start_box = 0 if page == 0 else 1  # skip first box on subsequent pages (overlap)

        for i in range(start_box, len(boxes)):
            x, y = boxes[i]
            service_index += 1
            print(f"\n--- Service #{service_index} ---")

            # Create per-service folder
            service_dir = os.path.join(base_dir, f"service_{service_index:03d}")
            os.makedirs(service_dir, exist_ok=True)

            # Click the service box to select/highlight it
            print(f"       Clicking service at ({x}, {y})...")
            pyautogui.moveTo(x, y)
            time.sleep(0.5)
            pyautogui.mouseDown()
            time.sleep(0.2)
            pyautogui.mouseUp()
            time.sleep(1.5)       # give game time to highlight the selection

            # Screenshot the selected service box
            img_path = screenshot_service_box(service_dir, y)
            print(f"       Saved service name: {img_path}")

            # Check for duplicate (scroll drift)
            if _service_is_duplicate(service_dir, prev_service_img):
                print(f"       DUPLICATE detected — skipping service #{service_index}")
                # Clean up the duplicate folder
                os.remove(img_path)
                os.rmdir(service_dir)
                service_index -= 1
                continue

            # Update previous service image for next comparison
            prev_service_img = np.array(Image.open(img_path))

            # Press Enter twice to load the level
            pyautogui.press("enter")
            time.sleep(1.0)
            pyautogui.press("enter")

            # Wait for level to load and get past "Get Started" screen
            # Passes click coordinates so it can re-click if the screen doesn't change
            wait_for_level_load(click_x=x, click_y=y)

            # Capture the schedule
            capture_schedule(service_dir)

            # Exit back to main menu (we're now at main menu)
            exit_to_main_menu()

            # Check service limit AFTER exiting to main menu, BEFORE re-navigating
            if max_services is not None and service_index >= max_services:
                print(f"\n       Reached service limit ({max_services}), stopping.")
                print(f"\nProcessed {service_index} services for this train.")
                return  # at main menu

            # Re-navigate to the service list
            navigate_to_service_list(train_index)

            # Scroll back to the right position
            print(f"       Scrolling back to page {page}...")
            for _ in range(page):
                scroll_service_list_down()
            time.sleep(1.0)

        # Scroll down for the next page
        print(f"\n--- Scrolling to next page (page {page + 1}) ---")
        scroll_service_list_down()

        # Take a screenshot to check if we've reached the end
        # (compare with previous page - if identical, we're done)
        check_region = (
            config.SERVICE_LIST_LEFT,
            config.SERVICE_LIST_TOP,
            config.SERVICE_LIST_RIGHT - config.SERVICE_LIST_LEFT,
            config.SERVICE_LIST_BOTTOM - config.SERVICE_LIST_TOP,
        )
        current_page_screenshot = pyautogui.screenshot(region=check_region)

        if previous_screenshot is not None:
            current_arr = np.array(current_page_screenshot)
            prev_arr = np.array(previous_screenshot)
            if current_arr.shape == prev_arr.shape:
                diff = np.mean(np.abs(current_arr.astype(float) - prev_arr.astype(float)))
                print(f"       Page difference: {diff:.1f}")
                if diff < 5.0:  # nearly identical = end of list
                    print("\n=== Reached end of service list ===")
                    break

        previous_screenshot = current_page_screenshot
        page += 1

    # Natural end of service list — we're at the service list (a menu).
    # Need to get back to main menu for the train loop.
    print(f"\n       Reached end of service list. Returning to main menu...")
    _return_to_main_menu_from_menus()
    print(f"\nProcessed {service_index} services for this train.")


def process_all_trains():
    """Outer loop: iterate through all trains in the class, processing services for each."""
    # Create class-level folder
    class_dir = os.path.join(config.SCREENSHOTS_DIR, config.TRAIN_CLASS)
    os.makedirs(class_dir, exist_ok=True)

    train_count = count_trains()
    print(f"\n=== Processing {train_count} trains for '{config.TRAIN_CLASS}' ===\n")

    for train_idx in range(train_count):
        print(f"\n{'='*50}")
        print(f"=== Train {train_idx + 1}/{train_count} ===")
        print(f"{'='*50}")

        # Create per-train folder inside class folder
        train_dir = os.path.join(class_dir, f"train_{train_idx + 1:02d}")
        os.makedirs(train_dir, exist_ok=True)

        # Click the train
        click_train(train_idx)

        # Process services for this train
        process_all_services(
            base_dir=train_dir,
            train_index=train_idx,
            max_services=config.MAX_SERVICES_PER_TRAIN,
        )

        # process_all_services returns at main menu (when limit hit).
        # Navigate back to the train list for the next train.
        if train_idx < train_count - 1:
            navigate_to_train_list()

    print(f"\n=== All {train_count} trains processed! ===")
