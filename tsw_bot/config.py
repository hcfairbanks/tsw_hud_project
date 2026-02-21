import os

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REFERENCES_DIR = os.path.join(BASE_DIR, "references")
SCREENSHOTS_DIR = os.path.join(BASE_DIR, "screenshots")

# Steam
STEAM_APP_ID = "3656800"

# Timeouts (seconds)
GAME_LAUNCH_TIMEOUT = 120   # TSW takes a while to start
SCREEN_TIMEOUT = 60         # waiting for a menu screen to appear
CLICK_SETTLE_DELAY = 2.0    # pause after clicking before looking for next screen

# Image matching confidence thresholds
CONFIDENCE = 0.8            # default for menu tiles
CONFIDENCE_LOW = 0.6        # for warning/splash screens (simpler visuals)

# Reference image paths
REF_WARNING_CONTINUE = os.path.join(REFERENCES_DIR, "warning_continue.png")
REF_SPLASH_CONTINUE = os.path.join(REFERENCES_DIR, "splash_continue.png")
REF_TO_THE_TRAINS = os.path.join(REFERENCES_DIR, "to_the_trains.png")
REF_CHOOSE_A_ROUTE = os.path.join(REFERENCES_DIR, "choose_a_route.png")
REF_CHOOSE_A_ROUTE_SCREEN = os.path.join(REFERENCES_DIR, "choose_a_route_screen.png")
REF_ROUTE_FILTER = os.path.join(REFERENCES_DIR, "route_filter.png")
REF_TIMETABLE = os.path.join(REFERENCES_DIR, "timetable.png")
REF_CLASS_FILTER = os.path.join(REFERENCES_DIR, "class_filter.png")
REF_EXIT_TO_MAIN_MENU = os.path.join(REFERENCES_DIR, "exit_to_main_menu.png")
REF_GET_STARTED = os.path.join(REFERENCES_DIR, "get_started.png")
REF_GET_STARTED_2 = os.path.join(REFERENCES_DIR, "get_started_2.png")
REF_DRIVER = os.path.join(REFERENCES_DIR, "driver.png")
REF_DRIVER_1 = os.path.join(REFERENCES_DIR, "driver_1.png")

# Route to select
ROUTE_NAME = "WCML South - London Euston to Milton Keynes"

# Train class to select
TRAIN_CLASS = "Class 390"

# Service list scroll area (pixel coordinates)
SERVICE_LIST_LEFT = 2059
SERVICE_LIST_TOP = 335
SERVICE_LIST_RIGHT = 2664
SERVICE_LIST_BOTTOM = 912
SERVICE_BOX_HEIGHT = 59       # actual box height in pixels
SERVICE_BOX_STRIDE = 71       # distance between box tops (59 box + 12 gap)
SCROLL_PER_BOX = -268         # scroll clicks to move one box down (-2140 / 8)
SERVICE_BOX_BORDER_RGB = (0x57, 0xa6, 0xd0)  # #57a6d0 — border color of service rectangles
SERVICE_BOX_COLOR_TOLERANCE = 20              # per-channel tolerance for color matching
LEVEL_LOAD_TIMEOUT = 180     # seconds to wait for a level to load

# Schedule screen area (pixel coordinates)
REF_SCHEDULE = os.path.join(REFERENCES_DIR, "schedule.png")
SCHEDULE_LEFT = 2053
SCHEDULE_TOP = 235
SCHEDULE_RIGHT = 3675
SCHEDULE_BOTTOM = 902
SCHEDULE_TOP_BORDER_RGB = (0x05, 0x97, 0x44)     # #059744 — top border of schedule
SCHEDULE_BOTTOM_BORDER_RGB = (0xc5, 0xe4, 0xe9)  # #c5e4e9 — bottom border of schedule
SCHEDULE_COLOR_TOLERANCE = 20

# Train scroll box (pixel coordinates)
TRAIN_BOX_LEFT = 3218
TRAIN_BOX_TOP = 418
TRAIN_BOX_WIDTH = 450
TRAIN_BOX_HEIGHT = 472
TRAIN_SCROLL_PER_BOX = -310   # scroll clicks to move one train box down
TRAIN_VISIBLE_COUNT = 5       # trains visible without scrolling
TRAIN_FIRST_Y_OFFSET = 47     # Y offset from TRAIN_BOX_TOP to center of first train
TRAIN_BOX_STRIDE = 94         # distance between train box centers (472px / 5 trains ≈ 94)

# Limits (None = unlimited)
MAX_SERVICES_PER_TRAIN = 10   # cap services per train for faster testing

# Retry settings (when a click doesn't register and the screen doesn't change)
RETRY_MAX = 3                # total click attempts before giving up
RETRY_WAIT = 30              # seconds to wait for screen change before retrying click
