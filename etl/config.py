import os

# Database Configuration Strings
# Throws an error upstream if SPATIAL_DB_URL is missing, enforcing safety
SPATIAL_DB_URL = os.getenv("SPATIAL_DB_URL")
BUSINESS_DB_URL = os.getenv("BUSINESS_DB_URL", SPATIAL_DB_URL)

# Dynamically calculate the root path relative to the container/host execution point
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_GDB_PATH = os.path.join(BASE_DIR, "etl", "data", "tablejoiner", "tablejoiner.gdb", "dcad_parcels")

# Shapefile File Settings
RAW_SHAPEFILE_PATH = os.getenv("RAW_SHAPEFILE_PATH", DEFAULT_GDB_PATH)
TARGET_SRID = 4326  # Master Warehousing Coordinate System (WGS 84)