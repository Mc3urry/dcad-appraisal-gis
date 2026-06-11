# filepath: ml_analytics/train_models.py
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, IsolationForest
from sqlalchemy import create_engine, text
from etl.config import SPATIAL_DB_URL

# Columns we WANT if they exist. The script adapts to whatever subset the
# dcad_accounts table actually has, so schema drift can't crash the query.
BASE_COLUMNS = ["account_num", "lma", "ima", "nbhd_cd", "biz_name", "owner_address_1"]

# Candidate columns for the property (situs) address, in preference order.
# Whichever exist get concatenated for the absentee-owner comparison.
PROPERTY_ADDR_CANDIDATES = [
    "property_address",
    "property_street_num", "property_street_name",
    "street_num", "street_half_num", "full_street_name", "street_name",
    "situs_address", "situs_street_num", "situs_street_name",
]

BIZ_KEYWORDS = ("LLC", "INC", "CORP", "LTD", "PARTNERS")


def get_existing_columns(engine, table):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = :t
        """), {"t": table}).fetchall()
    return {r[0] for r in rows}


def table_exists(engine, table):
    with engine.connect() as conn:
        return conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables WHERE table_name = :t
            )
        """), {"t": table}).scalar()


def execute_ml_analytics():
    engine = create_engine(SPATIAL_DB_URL)
    print("Extracting enterprise feature layers out of GIS spatial warehouse...")

    db_cols = get_existing_columns(engine, "dcad_accounts")
    if "account_num" not in db_cols:
        print("❌ Error: dcad_accounts table missing or has no account_num column.")
        return

    select_cols = [c for c in BASE_COLUMNS if c in db_cols]
    addr_cols = [c for c in PROPERTY_ADDR_CANDIDATES if c in db_cols]
    select_cols += [c for c in addr_cols if c not in select_cols]
    print(f" -> Columns available for feature extraction: {select_cols}")

    col_sql = ", ".join(f'"{c}"' for c in select_cols)

    # Protest history: only join if the protests table actually exists.
    if table_exists(engine, "protests"):
        protest_sql = """,
            (SELECT COUNT(*) FROM protests
             WHERE protests.account_num = dcad_accounts.account_num) AS protest_history"""
    else:
        print(" -> No 'protests' table found; protest_history defaults to 0.")
        protest_sql = ", 0 AS protest_history"

    query = text(f"SELECT {col_sql}{protest_sql} FROM dcad_accounts;")

    with engine.connect() as conn:
        df = pd.read_sql(query, con=conn)

    if df.empty or len(df) < 2:
        print("❌ Error: Insufficient transaction rows to compile statistical matrices.")
        return
    print(f" -> Pulled {len(df)} parcel records.")

    # ----- Feature engineering (all in pandas: immune to SQL type/schema drift) -----

    # Valuations: lma/ima may be NUMERIC, VARCHAR, contain 'UNASSIGNED', or be
    # missing entirely. Coerce to numeric; anything non-numeric becomes 0.
    for col in ("lma", "ima"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
        else:
            df[col] = 0.0

    # Year-over-year trend placeholders (populated once history columns exist)
    for col in ("lma_increase", "ima_increase"):
        if col not in df.columns:
            df[col] = 0.0

    # Absentee owner: owner mailing address differs from the property address,
    # built from whichever address columns this schema actually has.
    if "owner_address_1" in df.columns and addr_cols:
        prop_addr = (
            df[addr_cols]
            .astype(str)
            .replace({"None": "", "nan": "", "<NA>": ""})
            .agg(" ".join, axis=1)
            .str.split()
            .str.join(" ")  # collapse repeated whitespace
            .str.upper()
        )
        owner_addr = df["owner_address_1"].astype(str).str.strip().str.upper()
        df["is_absentee"] = (
            (owner_addr != "") & (prop_addr != "") & (owner_addr != prop_addr)
        ).astype(int)
    else:
        print(" -> Address columns unavailable; is_absentee defaults to 0.")
        df["is_absentee"] = 0

    # Corporate / business entity flag
    if "biz_name" in df.columns:
        biz = df["biz_name"].fillna("").astype(str).str.upper()
        pattern = "|".join(BIZ_KEYWORDS)
        df["is_business"] = (
            biz.str.contains(pattern, na=False) & (biz != "NONE REGISTERED")
        ).astype(int)
    else:
        df["is_business"] = 0

    df["protest_history"] = pd.to_numeric(df["protest_history"], errors="coerce").fillna(0).astype(int)

    feature_cols = ["lma", "ima", "lma_increase", "ima_increase",
                    "is_absentee", "is_business", "protest_history"]
    X = df[feature_cols]

    df["has_protested"] = (df["protest_history"] > 0).astype(int)

    # 🤖 Model 1: Protest Risk (Random Forest)
    # Guard: predict_proba()[:, 1] crashes if only one class is present.
    if df["has_protested"].nunique() < 2:
        print(" -> Model 1 skipped: only one protest class present; defaulting risk scores to 0.")
        df["protest_risk_score"] = 0.0
    else:
        classifier = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
        classifier.fit(X, df["has_protested"])
        df["protest_risk_score"] = classifier.predict_proba(X)[:, 1]
        print(" -> Model 1: Random Forest Protest Risk probabilities updated.")

    # 🔍 Model 2: Valuation Anomaly Detection (Isolation Forest)
    outlier_engine = IsolationForest(contamination=0.02, random_state=42)
    raw_anomalies = outlier_engine.fit_predict(X)
    df["anomaly_flag"] = [1 if x == -1 else 0 for x in raw_anomalies]
    print(f" -> Model 2: Isolation Forest isolated {int(df['anomaly_flag'].sum())} valuation exceptions.")

    output_df = df[["account_num", "protest_risk_score", "anomaly_flag"]]

    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE IF NOT EXISTS ml_analytics_outputs (
                account_num VARCHAR(50) PRIMARY KEY,
                protest_risk_score NUMERIC(4,3),
                anomaly_flag INT
            );
        """))
        connection.execute(text("TRUNCATE TABLE ml_analytics_outputs;"))

    output_df.to_sql("ml_analytics_outputs", con=engine,
                     if_exists="append", index=False, chunksize=25000, method="multi")
    print("Successfully committed updated ML score matrices back to PostgreSQL warehouse.")


if __name__ == "__main__":
    execute_ml_analytics()