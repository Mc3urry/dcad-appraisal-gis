# filepath: etl/load_dcad_accounts.py
import psycopg2
import psycopg2.extras
import pandas as pd
from sqlalchemy import create_engine, text
from etl.validate_accounts import validate_raw_data
from etl.config import SPATIAL_DB_URL


def load_master_parcels():
    gdf, errors_df = validate_raw_data()
    if gdf.empty:
        print("No master structural records available for database injection processing.")
        return

    engine = create_engine(SPATIAL_DB_URL)

    # -------------------------------------------------------------------------
    # PRESERVE UNASSIGNED PARCELS
    # -------------------------------------------------------------------------
    gdf["account_num"] = gdf["account_num"].astype(str).str.strip()
    is_unassigned = (
        gdf["account_num"].isna()
        | (gdf["account_num"] == "")
        | (gdf["account_num"].str.lower() == "nan")
        | (gdf["account_num"].str.lower() == "unassigned")
    )
    if is_unassigned.any():
        unassigned_count = is_unassigned.sum()
        print(f"Found {unassigned_count} unassigned parcels. Assigning generated database placeholders...")
        gdf.loc[is_unassigned, "account_num"] = [f"UNASSIGNED_{i}" for i in range(unassigned_count)]

    gdf = gdf.drop_duplicates(subset=["account_num"], keep="first")

    print("Writing master parcel layers to PostGIS warehouse (dcad_accounts)...")

    # Normalize geometry column to the DB name and serialize to WKT
    raw_spatial_shapes = gdf.geometry
    gdf = gdf.rename(columns={"geometry": "geom"})

    if "appraisal_yr" in gdf.columns:
        gdf["appraisal_yr"] = pd.to_numeric(gdf["appraisal_yr"], errors="coerce").fillna(2026).astype(int)

    # -------------------------------------------------------------------------
    # lma / ima: PRESERVE TEXT VALUES (column is varchar BY DESIGN so values
    # like "UNASSIGNED" survive to the frontend). Only normalize whitespace
    # and convert empty/'nan' artifacts to NULL. Anything numeric stays a
    # numeric *string*; downstream consumers (ML, stats) coerce defensively.
    # -------------------------------------------------------------------------
    for col in ["lma", "ima"]:
        if col in gdf.columns:
            gdf[col] = gdf[col].astype(str).str.strip()
            gdf[col] = gdf[col].replace({"nan": None, "None": None, "<NA>": None, "": None})

    if "deed_txfr_date" in gdf.columns:
        gdf["deed_txfr_date"] = pd.to_datetime(gdf["deed_txfr_date"], errors="coerce")
        gdf["deed_txfr_date"] = gdf["deed_txfr_date"].dt.strftime("%Y-%m-%d")

    gdf["geom"] = raw_spatial_shapes.to_wkt()

    # Introspect DB schema; insert only the intersection of columns
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'dcad_accounts'
              AND column_name NOT IN ('account_id', 'created_at');
        """))
        db_columns = [row[0] for row in result]

    insert_columns = [col for col in db_columns if col in gdf.columns]
    print(f" -> Insertable columns matched against DB schema: {insert_columns}")

    final_df = gdf[insert_columns].copy()
    final_df = final_df.astype(object).where(final_df.notna(), None)
    records = final_df.to_dict(orient="records")

    # -------------------------------------------------------------------------
    # UPSERT INSTEAD OF TRUNCATE CASCADE.
    # The old TRUNCATE TABLE dcad_accounts CASCADE wiped appraisal_history and
    # protests (both have FKs to this table) on EVERY nightly run — destroying
    # exactly the longitudinal data the history/ML steps depend on.
    # ON CONFLICT (account_num) DO UPDATE refreshes parcels in place and
    # leaves child tables untouched.
    # -------------------------------------------------------------------------
    col_names_str = ", ".join(f'"{col}"' for col in insert_columns)
    val_placeholders = ", ".join(
        "ST_GeomFromText(%(geom)s, 4326)" if col == "geom" else f"%({col})s"
        for col in insert_columns
    )
    update_assignments = ", ".join(
        f'"{col}" = EXCLUDED."{col}"' for col in insert_columns if col != "account_num"
    )
    insert_query = f"""
        INSERT INTO dcad_accounts ({col_names_str})
        VALUES ({val_placeholders})
        ON CONFLICT (account_num) DO UPDATE SET {update_assignments};
    """

    try:
        pg_conn = psycopg2.connect(SPATIAL_DB_URL)
        pg_conn.autocommit = True
        pg_cursor = pg_conn.cursor()

        chunk_size = 25000
        total_records = len(records)
        print(f"Executing upsert stream of {total_records} records...")

        for i in range(0, total_records, chunk_size):
            chunk = records[i:i + chunk_size]
            psycopg2.extras.execute_batch(pg_cursor, insert_query, chunk, page_size=5000)
            print(f"   -> Upserted rows {i} through {min(i + chunk_size, total_records)}...")

        # ---------------------------------------------------------------------
        # STALE PARCEL CLEANUP: remove accounts no longer present in the source
        # layer. This delete cascades history/protests ONLY for parcels that
        # genuinely no longer exist — which is the correct behavior.
        # ---------------------------------------------------------------------
        print("Reconciling stale parcels no longer present in source layer...")
        pg_cursor.execute("""
            CREATE TEMP TABLE current_load_accounts (account_num VARCHAR(50) PRIMARY KEY)
            ON COMMIT PRESERVE ROWS;
        """)
        account_rows = [(r["account_num"],) for r in records]
        psycopg2.extras.execute_values(
            pg_cursor,
            "INSERT INTO current_load_accounts (account_num) VALUES %s ON CONFLICT DO NOTHING",
            account_rows, page_size=10000,
        )
        pg_cursor.execute("""
            DELETE FROM dcad_accounts a
            WHERE NOT EXISTS (
                SELECT 1 FROM current_load_accounts c
                WHERE c.account_num = a.account_num
            );
        """)
        print(f"   -> Removed {pg_cursor.rowcount} stale parcel records.")
        pg_cursor.execute("DROP TABLE current_load_accounts;")

        pg_cursor.close()
        pg_conn.close()
        print("Successfully committed spatial records to database engine stream.")
    except Exception as e:
        print(f"CRITICAL WRITE ERROR DURING BATCH UPSERT: {e}")
        raise e

    # -------------------------------------------------------------------------
    # QA ISSUE LOGGING: purge previous ingestion-phase issue types first so
    # nightly runs don't stack duplicate rows (mirrors what topology_checks
    # does for its own issue types), then batch-insert.
    # -------------------------------------------------------------------------
    if not errors_df.empty:
        print(f"Logging {len(errors_df)} detected anomalies into qa_issues table...")
        conn = psycopg2.connect(SPATIAL_DB_URL)
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute("""
            DELETE FROM qa_issues
            WHERE issue_type IN ('Invalid Geometry', 'Missing Attribute');
        """)
        issue_rows = [
            (row["account_num"], row["issue_type"], row["description"], row["severity"])
            for _, row in errors_df.iterrows()
            if pd.notna(row["account_num"]) and str(row["account_num"]).strip() != ""
        ]
        psycopg2.extras.execute_batch(cursor, """
            INSERT INTO qa_issues (account_num, issue_type, description, severity, status)
            VALUES (%s, %s, %s, %s, 'OPEN')
        """, issue_rows, page_size=5000)
        cursor.close()
        conn.close()

    print("ETL Data ingestion phase complete.")


if __name__ == "__main__":
    load_master_parcels()