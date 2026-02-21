import os
import sys

import pyautogui
pyautogui.FAILSAFE = False

import config
from navigator import (
    launch_game,
    pass_warning_screen,
    pass_splash_screen,
    click_to_the_trains,
    click_choose_a_route,
    wait_for_route_screen,
    select_route,
    click_timetable,
    select_train_class,
)


def check_references():
    """Verify that all required reference images exist."""
    required = [
        config.REF_WARNING_CONTINUE,
        config.REF_SPLASH_CONTINUE,
        config.REF_TO_THE_TRAINS,
        config.REF_CHOOSE_A_ROUTE,
        config.REF_CHOOSE_A_ROUTE_SCREEN,
        config.REF_ROUTE_FILTER,
        config.REF_TIMETABLE,
        config.REF_CLASS_FILTER,
        config.REF_EXIT_TO_MAIN_MENU,
        config.REF_GET_STARTED,
        config.REF_DRIVER,
    ]
    missing = [path for path in required if not os.path.isfile(path)]
    if missing:
        print("ERROR: Missing reference images:")
        for path in missing:
            print(f"  - {os.path.basename(path)}")
        print(f"\nPlease add them to: {config.REFERENCES_DIR}")
        return False
    return True


def main():
    print("=== TSW Timetable Bot ===\n")

    if not check_references():
        sys.exit(1)

    os.makedirs(config.SCREENSHOTS_DIR, exist_ok=True)

    try:
        launch_game()
        pass_warning_screen()
        pass_splash_screen()
        click_to_the_trains()
        click_choose_a_route()
        wait_for_route_screen()
        select_route()
        click_timetable()
        select_train_class()
        print("\nTrain list reached — starting train loop.\n")

        from service_loop import process_all_trains
        process_all_trains()
    except TimeoutError as e:
        print(f"\nERROR: {e}")
        print("The bot could not find the expected screen element.")
        print("Make sure TSW is visible and not obscured by other windows.")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nBot stopped by user.")
        sys.exit(0)


if __name__ == "__main__":
    main()
