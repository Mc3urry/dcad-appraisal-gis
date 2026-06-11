# filepath: etl/generate_history.py
import pandas as pd
import psycopg2
from psycopg2.extras import execute_batch
from sqlalchemy import create_engine
from etl.config import SPATIAL_DB_URL, BUSINESS_DB_URL


def update_appraisal_history():
    print("Extracting current parcel parameters from SPATIAL database...")
    spatial_engine = create_engine(SPATIAL_DB_URL)

    try:
        df = pd.read_sql_query(
            "SELECT account_num, appraisal_yr, lma, ima FROM dcad_accounts;",
            con=spatial_engine,
        )
    except Exception as e:
        print(f"Failed to extract from spatial DB: {e}")
        return

    if df.empty:
        print("No accounts located inside arcgis_spatial to process history tracking.")
        return

    # lma/ima are varchar in dcad_accounts (values like 'UNASSIGNED' are kept
    # by design). For the history ledger we need numbers: coerce, non-numeric
    # becomes 0.0 so totals and change percentages stay computable.
    df["lma_num"] = pd.to_numeric(df["lma"], errors="coerce").fillna(0.0)
    df["ima_num"] = pd.to_numeric(df["ima"], errors="coerce").fillna(0.0)
    df["account_num"] = df["account_num"].astype(str).str.strip()
    df["appraisal_yr"] = pd.to_numeric(df["appraisal_yr"], errors="coerce").fillna(2026).astype(int)

    print(f"Pulled {len(df)} records. Connecting to BUSINESS database...")
    business_conn = psycopg2.connect(BUSINESS_DB_URL)
    business_conn.autocommit = True
    cursor = business_conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS appraisal_history (
            history_id BIGSERIAL PRIMARY KEY,
            account_num VARCHAR(50),
            appraisal_yr INTEGER,
            lma NUMERIC(14,2),
            ima NUMERIC(14,2),
            total_market_value NUMERIC(14,2),
            value_change_pct NUMERIC(8,4),
            created_at TIMESTAMP DEFAULT NOW()
        );
    """)
    # Idempotency guard at the database level: one history row per
    # account per appraisal year.
    cursor.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_appraisal_history_acct_yr
        ON appraisal_history (account_num, appraisal_yr);
    """)

    # -------------------------------------------------------------------------
    # FIX: the previous version deduplicated on account_num ALONE, so once a
    # parcel had any history row, no future year could ever be added — the
    # ledger could never accumulate year-over-year data. Deduplicate on the
    # (account_num, appraisal_yr) PAIR instead: same year re-runs are skipped,
    # new appraisal years insert.
    # -------------------------------------------------------------------------
    print("Querying existing (account, year) pairs from the BUSINESS ledger...")
    cursor.execute("""
        SELECT account_num, appraisal_yr FROM appraisal_history
        WHERE account_num IS NOT NULL;
    """)
    existing_pairs = set((row[0], row[1]) for row in cursor.fetchall())
    print(f"Found {len(existing_pairs)} pre-existing (account, year) ledger entries.")

    # -------------------------------------------------------------------------
    # FIX: value_change_pct was hardcoded to 0. Compute it against each
    # account's most recent PRIOR-year total already in the ledger.
    # -------------------------------------------------------------------------
    print("Loading prior-year totals for change-percentage computation...")
    cursor.execute("""
        SELECT DISTINCT ON (account_num) account_num, appraisal_yr, total_market_value
        FROM appraisal_history
        ORDER BY account_num, appraisal_yr DESC;
    """)
    prior_totals = {row[0]: (row[1], float(row[2]) if row[2] is not None else 0.0)
                    for row in cursor.fetchall()}

    sync_query = """
        INSERT INTO appraisal_history
            (account_num, appraisal_yr, lma, ima, total_market_value, value_change_pct)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (account_num, appraisal_yr) DO NOTHING;
    """

    records_to_insert = []
    skipped_count = 0

    for row in df.itertuples(index=False):
        account_num = row.account_num
        appraisal_yr = row.appraisal_yr

        if (account_num, appraisal_yr) in existing_pairs:
            skipped_count += 1
            continue

        lma = float(row.lma_num)
        ima = float(row.ima_num)
        total_market_value = lma + ima

        # Year-over-year change vs. the latest prior year on record
        value_change_pct = 0.0
        prior = prior_totals.get(account_num)
        if prior is not None:
            prior_yr, prior_total = prior
            if prior_yr < appraisal_yr and prior_total > 0:
                value_change_pct = round(
                    ((total_market_value - prior_total) / prior_total) * 100.0, 4
                )

        records_to_insert.append(
            (account_num, appraisal_yr, lma, ima, total_market_value, value_change_pct)
        )

    if records_to_insert:
        print(f"Executing batch insert of {len(records_to_insert)} new historical records "
              f"(Skipped {skipped_count} already-tracked year entries)...")
        execute_batch(cursor, sync_query, records_to_insert, page_size=5000)
    else:
        print(f"All {len(df)} properties already tracked for their current appraisal year. "
              f"No inserts needed.")

    cursor.close()
    business_conn.close()
    print("Appraisal history logs successfully integrated across data stores.")


if __name__ == "__main__":
    update_appraisal_history()