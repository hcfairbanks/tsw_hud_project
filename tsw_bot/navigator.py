import os
import subprocess
import time

import numpy as np
import pyautogui

import config
from utils import wait_and_click, wait_for_image


def launch_game():
    """Launch TSW 6 via Steam."""
    print("[1/6] Launching Train Sim World 6 via Steam...")
    subprocess.Popen(
        ["cmd", "/c", "start", f"steam://rungameid/{config.STEAM_APP_ID}"],
        shell=False,
    )
    # Give Steam a moment to start the game process
    time.sleep(5)


def pass_warning_screen():
    """Wait for the warning screen and click to continue."""
    print("[2/6] Waiting for warning screen...")
    if not wait_and_click(config.REF_WARNING_CONTINUE, timeout=config.GAME_LAUNCH_TIMEOUT, confidence=config.CONFIDENCE_LOW):
        raise TimeoutError("Timed out waiting for warning screen")
    print("       Clicked past warning screen.")
    time.sleep(config.CLICK_SETTLE_DELAY)


def pass_splash_screen():
    """Wait for the splash screen and click to continue."""
    print("[3/6] Waiting for splash screen...")
    if not wait_and_click(config.REF_SPLASH_CONTINUE, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE_LOW):
        raise TimeoutError("Timed out waiting for splash screen")
    print("       Clicked past splash screen.")
    time.sleep(config.CLICK_SETTLE_DELAY)


def click_to_the_trains():
    """Click the 'To The Trains' tile on the main menu."""
    print("[4/6] Waiting for main menu — looking for 'To The Trains'...")
    if not wait_and_click(config.REF_TO_THE_TRAINS, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE):
        raise TimeoutError("Timed out waiting for 'To The Trains' tile")
    print("       Clicked 'To The Trains'.")
    time.sleep(config.CLICK_SETTLE_DELAY)


def click_choose_a_route():
    """Click the 'Choose a Route' tile."""
    print("[5/6] Waiting for menu — looking for 'Choose a Route'...")
    if not wait_and_click(config.REF_CHOOSE_A_ROUTE, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE):
        raise TimeoutError("Timed out waiting for 'Choose a Route' tile")
    print("       Clicked 'Choose a Route'.")
    time.sleep(config.CLICK_SETTLE_DELAY)


def wait_for_route_screen():
    """Wait until the route selection screen has loaded."""
    print("[6/6] Waiting for route selection screen to load...")
    location = wait_for_image(config.REF_CHOOSE_A_ROUTE_SCREEN, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE)
    if location is None:
        raise TimeoutError("Timed out waiting for route selection screen")
    print("       Route selection screen detected.")
    return True


def select_route(route_name=None):
    """Filter and select a route by typing into the search field and pressing Enter."""
    if route_name is None:
        route_name = config.ROUTE_NAME
    print(f"[7/7] Selecting route: {route_name}")

    # Click the filter text field (stays on screen after click, so skip verify)
    print("       Clicking route filter field...")
    if not wait_and_click(config.REF_ROUTE_FILTER, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE, verify=False):
        raise TimeoutError("Timed out waiting for route filter field")
    time.sleep(0.5)

    # Clear any existing text and type the route name
    print(f"       Typing: {route_name}")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.typewrite(route_name, interval=0.03)
    time.sleep(1.0)

    # Press Enter twice to select
    print("       Pressing Enter to select route...")
    pyautogui.press("enter")
    time.sleep(0.5)
    pyautogui.press("enter")
    time.sleep(config.CLICK_SETTLE_DELAY)
    print("       Route selected!")


def click_timetable():
    """Click the 'Timetable' tile."""
    print("[8/8] Waiting for menu — looking for 'Timetable'...")
    if not wait_and_click(config.REF_TIMETABLE, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE):
        raise TimeoutError("Timed out waiting for 'Timetable' tile")
    print("       Clicked 'Timetable'.")
    time.sleep(config.CLICK_SETTLE_DELAY)


def select_train_class(class_name=None):
    """Filter and select a train class by typing into the search field and pressing Enter."""
    if class_name is None:
        class_name = config.TRAIN_CLASS
    print(f"[9/9] Selecting train class: {class_name}")

    # Click the class filter text field (stays on screen after click, so skip verify)
    print("       Clicking class filter field...")
    if not wait_and_click(config.REF_CLASS_FILTER, timeout=config.SCREEN_TIMEOUT, confidence=config.CONFIDENCE, verify=False):
        raise TimeoutError("Timed out waiting for class filter field")
    time.sleep(0.5)

    # Clear any existing text and type the class name
    print(f"       Typing: {class_name}")
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.typewrite(class_name, interval=0.03)
    time.sleep(1.0)

    # Press Enter, then right arrow, then Enter to select
    print("       Pressing Enter to select class...")
    pyautogui.press("enter")
    time.sleep(0.5)
    print("       Pressing Right arrow...")
    pyautogui.press("right")
    time.sleep(0.5)
    print("       Pressing Enter to confirm...")
    pyautogui.press("enter")
    time.sleep(config.CLICK_SETTLE_DELAY)
    print("       Train class selected!")
    time.sleep(1.0)


def _detect_train_positions():
    """Capture the train box and return Y centers of visible trains (screen coords).

    Uses #dedede border detection on the left edge, same as count_visible_trains.
    Returns a list of absolute screen Y coordinates for each train center.
    """
    region = (config.TRAIN_BOX_LEFT, config.TRAIN_BOX_TOP,
              config.TRAIN_BOX_WIDTH, config.TRAIN_BOX_HEIGHT)
    img = np.array(pyautogui.screenshot(region=region))

    border_rgb = np.array([0xde, 0xde, 0xde])
    strip = img[:, :3, :].astype(int)
    match = np.all(np.abs(strip - border_rgb) <= 20, axis=2)
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

    # Filter to real entries (>= 40px) and convert to screen Y centers
    positions = []
    for s, e in runs:
        if (e - s) >= 40:
            center_y = config.TRAIN_BOX_TOP + (s + e) // 2
            positions.append(center_y)
    return positions


def click_train(index):
    """Click train at the given index (0-based).

    Uses scroll-based positioning instead of border detection:
    1. Scrolls to the top of the train list
    2. Scrolls down one box at a time (up to `index` times), checking
       via frame comparison whether each scroll actually moved the list
    3. Computes click Y from the number of scrolls that succeeded
       and a fixed stride, so highlighting can't shift the position
    """
    print(f"       Selecting train #{index + 1}...")

    click_x = config.TRAIN_BOX_LEFT + config.TRAIN_BOX_WIDTH // 2
    scroll_x = click_x
    scroll_y = config.TRAIN_BOX_TOP + config.TRAIN_BOX_HEIGHT // 2
    region = (config.TRAIN_BOX_LEFT, config.TRAIN_BOX_TOP,
              config.TRAIN_BOX_WIDTH, config.TRAIN_BOX_HEIGHT)

    # 1. Scroll to the very top for consistent starting position
    pyautogui.moveTo(scroll_x, scroll_y)
    time.sleep(0.3)
    pyautogui.scroll(-config.TRAIN_SCROLL_PER_BOX * 30)
    time.sleep(1.5)

    # 2. Scroll down one box at a time, verifying each scroll moved
    scrolls_done = 0
    for _ in range(index):
        before = np.array(pyautogui.screenshot(region=region))
        pyautogui.moveTo(scroll_x, scroll_y)
        time.sleep(0.3)
        pyautogui.scroll(config.TRAIN_SCROLL_PER_BOX)
        time.sleep(1.0)
        after = np.array(pyautogui.screenshot(region=region))

        if np.mean(np.abs(before.astype(float) - after.astype(float))) < 5.0:
            print(f"       Scroll stopped after {scrolls_done} (list end reached)")
            break
        scrolls_done += 1

    # 3. The target train is at offset (index - scrolls_done) from the top
    offset = index - scrolls_done
    click_y = config.TRAIN_BOX_TOP + config.TRAIN_FIRST_Y_OFFSET + offset * config.TRAIN_BOX_STRIDE

    print(f"       Scrolled {scrolls_done}/{index}, offset in view: {offset}, "
          f"click Y: {click_y}")
    pyautogui.moveTo(click_x, click_y)
    time.sleep(0.5)
    pyautogui.mouseDown()
    time.sleep(0.2)
    pyautogui.mouseUp()
    time.sleep(5.0)           # service list needs time to populate
    print(f"       Train #{index + 1} selected!")
