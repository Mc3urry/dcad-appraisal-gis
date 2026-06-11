import os
# filepath: etl/validate_accounts.py
import os
import geopandas as gpd
import pandas as pd
from etl.config import RAW_SHAPEFILE_PATH, TARGET_SRID

# Target column names = EXACTLY the dcad_accounts database schema
# (introspected from \d dcad_accounts). The loader inserts only the
# intersection of dataframe columns and DB columns, so any name that
# doesn't match the DB is silently dropped — keep this list in sync
# with the table.
TARGET_COLUMNS = [
    "account_num", "appraisal_yr", "division_cd", "biz_name",
    "owner_name1", "owner_name2", "exclude_owner",
    "owner_address_1", "owner_address_2", "owner_address_3", "owner_address_4",
    "owner_city", "owner_state", "owner_zipcode", "owner_country",
    "street_num", "street_half_num", "full_street_name",
    "bldg_id", "unit_id", "property_city", "property_zipcode",
    "mapsco", "nbhd_cd",
    "legal_1", "legal_2", "legal_3", "legal_4", "legal_5",
    "deed_txfr_date", "gis_parcel_id", "phone_num",
    "lma", "ima",
]

# Map GDB/export field-name variants -> database column names.
# Covers DCAD export naming and the older ETL naming so either source works.
RENAME_MATRIX = {
    # owner mailing address variants
    "owner_address_line1": "owner_address_1",
    "owner_address_line2": "owner_address_2",
    "owner_address_line3": "owner_address_3",
    "owner_address_line4": "owner_address_4",
    "owner_zip": "owner_zipcode",
    # situs / property address variants
    "property_street_num": "street_num",
    "property_street_name": "full_street_name",
    "property_zip": "property_zipcode",
    "situs_street_num": "street_num",
    "situs_street_name": "full_street_name",
    "situs_zip": "property_zipcode",
    # legal description variants
    "legal1": "legal_1",
    "legal2": "legal_2",
    "legal3": "legal_3",
    "legal4": "legal_4",
    "legal5": "legal_5",
}


def validate_raw_data():
    print("Reading Geodatabase layer out of production path settings...")
    try:
        gdb_path = os.path.dirname(RAW_SHAPEFILE_PATH)
        layer_name = os.path.basename(RAW_SHAPEFILE_PATH)

        print(f" -> Accessing GDB: {gdb_path}")
        print(f" -> Reading Layer Target: {layer_name}")

        gdf = gpd.read_file(gdb_path, layer=layer_name)
    except Exception as e:
        print(f"CRITICAL ERROR reading Geodatabase: {e}")
        raise e

    # 1. Normalize column case, then map variants onto the DB schema names
    gdf.columns = gdf.columns.str.lower()
    original_geometry_column = gdf.geometry.name
    gdf = gdf.rename(columns=RENAME_MATRIX)

    # 2. Subset to the columns the database can actually accept
    existing_targets = [col for col in TARGET_COLUMNS if col in gdf.columns]

    # Loudly report expected columns the source file does NOT provide,
    # so schema drift never silently drops data again.
    missing = [col for col in TARGET_COLUMNS if col not in gdf.columns]
    if missing:
        print(f" ⚠️ Source layer is missing {len(missing)} expected fields "
              f"(these DB columns will be NULL): {missing}")

    gdf = gdf[existing_targets + [original_geometry_column]]
    if original_geometry_column != "geometry":
        gdf = gdf.rename(columns={original_geometry_column: "geometry"})
    gdf = gdf.set_geometry("geometry")

    print(f"Successfully mapped {len(gdf)} records into warehouse data frame schema.")

    # Coordinate Reference System Enforcement Layer
    if gdf.crs and gdf.crs.to_epsg() != TARGET_SRID:
        print(f"Projecting coordinate system to EPSG:{TARGET_SRID}...")
        gdf = gdf.to_crs(epsg=TARGET_SRID)

    # 3. Vectorized validation (the previous per-row iterrows loop was O(n)
    #    Python over ~700k rows; these masks do the same checks in seconds)
    errors_frames = []

    geom_invalid_mask = gdf.geometry.isna() | ~gdf.geometry.is_valid
    if geom_invalid_mask.any():
        bad = gdf.loc[geom_invalid_mask, ["account_num"]].copy()
        bad["issue_type"] = "Invalid Geometry"
        bad["description"] = "Geometry null or self-intersecting"
        bad["severity"] = "CRITICAL"
        errors_frames.append(bad)

    if "nbhd_cd" in gdf.columns:
        nbhd_missing_mask = gdf["nbhd_cd"].isna() | (gdf["nbhd_cd"].astype(str).str.strip() == "")
        if nbhd_missing_mask.any():
            bad = gdf.loc[nbhd_missing_mask, ["account_num"]].copy()
            bad["issue_type"] = "Missing Attribute"
            bad["description"] = "Missing Neighborhood classification string (nbhd_cd)"
            bad["severity"] = "MEDIUM"
            errors_frames.append(bad)

    errors_df = pd.concat(errors_frames, ignore_index=True) if errors_frames else pd.DataFrame(
        columns=["account_num", "issue_type", "description", "severity"]
    )
    return gdf, errors_df