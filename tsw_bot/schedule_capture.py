import os
import time

import numpy as np
import pyautogui
from PIL import Image

import config
from utils import wait_and_click

SCHEDULE_MAX_WIDTH = 1470
SEPARATOR_RGB = np.array([0x13, 0x2c, 0x39])  # #132c39 — dark line between blocks
SEPARATOR_TOL = 20

# The two alternating box colors in the schedule
BOX_COLORS = [
    np.array(config.SCHEDULE_BOTTOM_BORDER_RGB),   # #c5e4e9 (light blue)
    np.array(config.SCHEDULE_TOP_BORDER_RGB),       # #059744 (green)
]


def capture_schedule_region():
    """Capture the schedule area as a numpy array (RGB)."""
    region = (
        config.SCHEDULE_LEFT,
        config.SCHEDULE_TOP,
        config.SCHEDULE_RIGHT - config.SCHEDULE_LEFT,
        config.SCHEDULE_BOTTOM - config.SCHEDULE_TOP,
    )
    screenshot = pyautogui.screenshot(region=region)
    return np.array(screenshot)


def find_overlap(prev_img, curr_img, band_height=40):
    """Find overlap between two frames using a template-match approach.

    Takes a narrow horizontal band from the top of curr_img and searches
    for its position in prev_img. The overlap is (prev_height - match_row).
    Returns the number of rows to skip from the top of curr_img, or 0.
    """
    h = prev_img.shape[0]

    # Take a band from the top area of the new frame (skip first few rows
    # in case of edge artifacts)
    band_start = 5
    band = curr_img[band_start:band_start + band_height, :, :].astype(float)

    # Slide the band down through prev_img looking for a match
    best_row = -1
    best_diff = float("inf")

    for row in range(0, h - band_height):
        strip = prev_img[row:row + band_height, :, :].astype(float)
        diff = np.mean(np.abs(strip - band))
        if diff < best_diff:
            best_diff = diff
            best_row = row

    if best_diff < 5.0:
        overlap = h - best_row + band_start
        return overlap

    return 0


def is_separator_row(img, row):
    """Check if a row in the image is a dark separator line (#132c39)."""
    w = img.shape[1]
    left = w // 10
    right = w - w // 10
    pixels = img[row, left:right, :].astype(int)
    match = np.all(np.abs(pixels - SEPARATOR_RGB) <= SEPARATOR_TOL, axis=1)
    return np.mean(match) > 0.3


def find_nearest_separator(img, target_row, search_range=50):
    """Find the nearest separator row to target_row, searching up and down.

    Returns the first row of the separator, or target_row if none found.
    """
    h = img.shape[0]
    for offset in range(search_range):
        for row in [target_row - offset, target_row + offset]:
            if 0 <= row < h and is_separator_row(img, row):
                return row
    return target_row


def find_separator_end(img, sep_row):
    """Find the last row of a separator starting at sep_row.

    Walks downward while rows still match the separator color.
    Returns the row index just past the separator.
    """
    h = img.shape[0]
    row = sep_row
    while row < h and is_separator_row(img, row):
        row += 1
    return row


def stitch_images(images):
    """Stitch schedule frames, cutting at dark separator lines.

    Uses pixel overlap to find where frames overlap, then snaps the
    cut point to the nearest #132c39 separator so the join is invisible.
    Result keeps through the end of the separator; new frame starts after it.
    """
    if not images:
        return None
    if len(images) == 1:
        return Image.fromarray(images[0])

    result = images[0]

    for i in range(1, len(images)):
        overlap = find_overlap(images[i - 1], images[i])
        if overlap > 0:
            # Find the nearest separator in the new frame
            sep_start = find_nearest_separator(images[i], overlap)
            print(f"       Frame {i-1} → {i}: overlap={overlap}px, "
                  f"separator at row {sep_start}")

            # New frame starts FROM the separator (keeps the dark line)
            new_part = images[i][sep_start:, :, :]

            # Trim result to the matching separator (also keeps the dark line)
            # They overlap on the dark pixels — invisible join
            prev_sep = result.shape[0] - overlap + sep_start
            prev_sep = find_nearest_separator(result, prev_sep)
            result = result[:prev_sep, :, :]
        else:
            print(f"       Frame {i-1} → {i}: no overlap found, appending full frame")
            new_part = images[i]

        if new_part.shape[0] > 0:
            result = np.vstack([result, new_part])

    return Image.fromarray(result)


def crop_schedule(img):
    """Crop the stitched schedule: trim below the last box and cap width.

    Scans from the bottom up to find the last row that matches either box
    color (#c5e4e9 or #059744), then crops everything below it.
    Also limits width to SCHEDULE_MAX_WIDTH pixels from the left.
    """
    tol = config.SCHEDULE_COLOR_TOLERANCE
    w = img.shape[1]
    left = w // 10
    right = w - w // 10
    strip = img[:, left:right, :].astype(int)

    last_box_row = img.shape[0]
    for row in range(strip.shape[0] - 1, -1, -1):
        for color in BOX_COLORS:
            match = np.all(np.abs(strip[row] - color) <= tol, axis=1)
            if np.mean(match) > 0.3:
                last_box_row = row + 1
                break
        if last_box_row < img.shape[0]:
            break

    img = img[:last_box_row, :min(img.shape[1], SCHEDULE_MAX_WIDTH), :]
    return img


def scroll_schedule_down(amount=-2000):
    """Scroll the schedule area down."""
    center_x = (config.SCHEDULE_LEFT + config.SCHEDULE_RIGHT) // 2
    center_y = (config.SCHEDULE_TOP + config.SCHEDULE_BOTTOM) // 2
    pyautogui.moveTo(center_x, center_y)
    time.sleep(0.3)
    pyautogui.scroll(amount)
    time.sleep(2.0)


def frames_match(a, b, threshold=5.0):
    """Check if two frames are nearly identical (scroll didn't move)."""
    if a.shape != b.shape:
        return False
    diff = np.mean(np.abs(a.astype(float) - b.astype(float)))
    return diff < threshold


def capture_schedule(output_dir):
    """Capture the full schedule by scrolling and stitching.

    Presses Escape, clicks Schedule, captures frames, stitches them,
    and saves the result as schedule.png in output_dir.

    Returns the path to the saved schedule image, or None on failure.
    """
    # Press Escape to open pause menu
    print("       Pressing Escape for schedule...")
    pyautogui.press("escape")
    time.sleep(4.0)

    # Click 'Schedule'
    print("       Clicking 'Schedule'...")
    if not wait_and_click(config.REF_SCHEDULE, timeout=config.SCREEN_TIMEOUT,
                          confidence=config.CONFIDENCE):
        print("       ERROR: Could not find 'Schedule' on screen")
        return None
    time.sleep(3.0)

    # Capture frames by scrolling
    print("       Capturing schedule frames...")
    frames = []
    max_frames = 20

    for frame_idx in range(max_frames):
        img = capture_schedule_region()

        # Detect end of scroll: compare with previous frame
        if frames and frames_match(frames[-1], img):
            print(f"       Frame {frame_idx} matches previous — end of scroll")
            break

        frames.append(img)
        print(f"       Frame {frame_idx} captured")

        # Scroll down for next frame
        scroll_schedule_down()

    print(f"       Captured {len(frames)} frames, stitching...")

    # Stitch frames together
    stitched = stitch_images(frames)
    if stitched is None:
        print("       ERROR: No frames to stitch")
        return None

    # Crop: trim below last box, cap width
    stitched_arr = crop_schedule(np.array(stitched))
    stitched = Image.fromarray(stitched_arr)
    print(f"       Cropped to {stitched_arr.shape[0]}x{stitched_arr.shape[1]}")

    output_path = os.path.join(output_dir, "2_schedule.png")
    stitched.save(output_path)
    print(f"       Saved schedule: {output_path}")

    # Close schedule (press Escape)
    pyautogui.press("escape")
    time.sleep(2.0)

    return output_path
