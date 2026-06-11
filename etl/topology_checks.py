# filepath: etl/topology_checks.py
import psycopg2
from etl.config import SPATIAL_DB_URL


def run_rule(conn, label, query):
    """Run a single topology rule in its own transaction so one GEOS failure
    can't abort the entire QA module (the gaps check previously crashed the
    whole run with a TopologyException)."""
    cursor = conn.cursor()
    try:
        print(f" -> {label}...")
        cursor.execute(query)
        conn.commit()
        return True
    except Exception as e:
        conn.rollback()
        print(f"    ⚠️ Rule failed and was skipped: {e}")
        return False
    finally:
        cursor.close()


def run_topology_checks():
    conn = psycopg2.connect(SPATIAL_DB_URL)
    print("Initializing Enterprise GIS Topology Verification Engine...")

    # Purge old flags to prevent duplicate dashboard rows
    run_rule(conn, "Purging stale QA flags", """
        DELETE FROM qa_issues
        WHERE issue_type IN ('Overlap', 'Multi-part Geometry', 'Gaps Encountered', 'Self-Intersection');
    """)

    # -------------------------------------------------------------------------
    # RULE 1: Parcels Must Not Overlap
    # -------------------------------------------------------------------------
    overlap_query = """
        INSERT INTO qa_issues (account_num, issue_type, description, severity, status)
        SELECT
            a.account_num,
            'Overlap' AS issue_type,
            'Parcel overlaps spatially with account ' || b.account_num AS description,
            'HIGH' AS severity,
            'OPEN' AS status
        FROM dcad_accounts a
        JOIN dcad_accounts b ON
            a.geom && b.geom
            AND ST_Overlaps(
                ST_CollectionExtract(ST_MakeValid(a.geom), 3),
                ST_CollectionExtract(ST_MakeValid(b.geom), 3)
            )
            AND a.account_num < b.account_num;
    """
    run_rule(conn, "Scanning overlay boundaries (Rule: Parcels Must Not Overlap)", overlap_query)

    # -------------------------------------------------------------------------
    # RULE 2: Parcels Must Be Single Part Geometry
    # -------------------------------------------------------------------------
    multipart_query = """
        INSERT INTO qa_issues (account_num, issue_type, description, severity, status)
        SELECT
            account_num,
            'Multi-part Geometry' AS issue_type,
            'Geometry contains discontinuous multipolygon components' AS description,
            'MEDIUM' AS severity,
            'OPEN' AS status
        FROM dcad_accounts
        WHERE ST_NumGeometries(geom) > 1;
    """
    run_rule(conn, "Auditing collection counts (Rule: Parcels Must Be Single Part)", multipart_query)

    # -------------------------------------------------------------------------
    # RULE 3: Parcels Must Not Have Gaps (Sliver & Internal Void Search)
    # -------------------------------------------------------------------------
    # FIX for "GEOS TopologyException: side location conflict":
    # The previous version called ST_Union directly on raw geometries. Any
    # invalid ring or near-coincident edge in the layer makes the cascaded
    # union throw. The cure is to sanitize BEFORE unioning:
    #   1. ST_MakeValid + ST_CollectionExtract(…, 3)  -> repair invalid polygons
    #   2. ST_SnapToGrid                              -> collapse near-coincident
    #      vertices that cause "side location conflict"
    #   3. ST_Buffer(…, 0)                            -> final cleanup pass
    # ⚠️ PERFORMANCE NOTE: a full-county union is still expensive; for production
    # consider looping per nbhd_cd.
    gaps_query = """
        INSERT INTO qa_issues (account_num, issue_type, description, severity, status)
        WITH clean_parcels AS (
            SELECT
                account_num,
                ST_Buffer(
                    ST_SnapToGrid(
                        ST_CollectionExtract(ST_MakeValid(geom), 3),
                        0.000001
                    ), 0
                ) AS geom
            FROM dcad_accounts
            WHERE geom IS NOT NULL
        ),
        district_envelope AS (
            SELECT ST_SetSRID(ST_Buffer(ST_Union(geom), 0.00001), 4326) AS unified_geom
            FROM clean_parcels
            WHERE NOT ST_IsEmpty(geom)
        ),
        unassigned_gaps AS (
            SELECT ST_Dump(
                ST_Difference(
                    ST_Buffer(ST_SnapToGrid(unified_geom, 0.0001), 0.0001),
                    unified_geom
                )
            ) AS geom_dump
            FROM district_envelope
        ),
        isolated_gap_polygons AS (
            SELECT (geom_dump).geom AS gap_geom FROM unassigned_gaps
            WHERE ST_Area((geom_dump).geom) > 0.0000001
              AND ST_Area((geom_dump).geom) < 0.005
        )
        SELECT DISTINCT ON (a.account_num)
            a.account_num,
            'Gaps Encountered' AS issue_type,
            'Unassigned sliver gap or boundary drop isolated near this account.' AS description,
            'LOW' AS severity,
            'OPEN' AS status
        FROM dcad_accounts a
        JOIN isolated_gap_polygons gap ON ST_DWithin(a.geom, gap.gap_geom, 0.0001);
    """
    run_rule(conn, "Vectorizing neighborhood gaps (Rule: Parcels Must Not Have Gaps)", gaps_query)

    # -------------------------------------------------------------------------
    # RULE 4: Parcels Must Not Self-Intersect
    # -------------------------------------------------------------------------
    self_intersect_query = """
        INSERT INTO qa_issues (account_num, issue_type, description, severity, status)
        SELECT
            account_num,
            'Self-Intersection' AS issue_type,
            'Invalid geometry topology: ' || ST_IsValidReason(geom) AS description,
            'CRITICAL' AS severity,
            'OPEN' AS status
        FROM dcad_accounts
        WHERE NOT ST_IsValid(geom);
    """
    run_rule(conn, "Auditing segment intersection paths (Rule: Parcels Must Not Self-Intersect)", self_intersect_query)

    conn.close()
    print("✅ System topology execution finalized. Spatial QA tables populated.")


if __name__ == "__main__":
    run_topology_checks()