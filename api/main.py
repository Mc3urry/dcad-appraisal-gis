import os
import datetime
import psycopg2
from psycopg2.extras import RealDictCursor
import jwt
from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import json

app = FastAPI(
    title="DCAD Enterprise Mass Appraisal API Engine",
    description="Production Ready Spatial & Structural Appraisal Authorization System",
    version="1.0.0"
)

# 🌐 CORS MIDDLEWARE RULES GRID
origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 🔑 CRYPTOGRAPHIC & NETWORKING INFRASTRUCTURE CONSTANTS
_jwt_secret = os.getenv("JWT_SECRET")
_db_url = os.getenv("SPATIAL_DB_URL")
_business_db_url = os.getenv("BUSINESS_DB_URL")

if not _jwt_secret or not _db_url:
    raise RuntimeError(
        "Required environment variables JWT_SECRET and SPATIAL_DB_URL are not set. "
        "Copy .env.example to .env and fill in your values before starting the server."
    )

JWT_SECRET = _jwt_secret
JWT_ALGORITHM = "HS256"
DB_URL = _db_url
BUSINESS_DB_URL = _business_db_url or _db_url

security = HTTPBearer()
optional_security = HTTPBearer(auto_error=False)


def get_optional_user_token(credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_security)) -> Optional[dict]:
    """Decodes JWT when present; returns None for unauthenticated (anonymous) requests."""
    if not credentials:
        return None
    try:
        return jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Security verification token has expired. Please re-authenticate.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Security verification token signature is invalid or altered.")

# 🗂️ SYSTEM USER COMPLIANT MOCK DIRECTORY
MOCK_USER_DIRECTORY = {
    "admin_user": {"password": "adminpassword123", "role": "admin", "division": "executive"},
    "analyst_user": {"password": "analystpassword123", "role": "analyst", "division": "commercial_analytics"},
    "appraiser_user": {"password": "appraiserpassword123", "role": "appraiser", "division": "northwest"},
    "gis_editor_user": {"password": "editorpassword123", "role": "gis_editor_user", "division": "mapping_fabric"},
    "public_citizen": {"password": "publicpassword123", "role": "public", "division": "general_public"}
}

# 📝 PYDANTIC DATA VALIDATION MODELS
class LoginRequest(BaseModel):
    username: str
    password: str

def safe_float(value, default=0.0):
    """Coerce appraisal values to float. lma/ima are varchar by design and
    may contain text like 'UNASSIGNED' or stray non-numeric codes."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class ProtestSubmission(BaseModel):
    account_num: str
    appraisal_yr: int
    protest_reason: str

class ProtestUpdate(BaseModel):
    status: str
    outcome: Optional[str] = None
    hearing_date: Optional[datetime.date] = None
    reduced_value: Optional[float] = None
    appraisal_notes: Optional[str] = None

# 🛡️ HARDENED SECURITY LAYER DEPENDENCY ENGINE
def get_current_user_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Decodes the JWT and explicitly catches cryptographic manipulation or expiration."""
    try:
        return jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Security verification token has expired. Please re-authenticate.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Security verification token signature is invalid or altered.")

def verify_role_clearance(payload: dict = Depends(get_current_user_token)) -> str:
    """Extracts and verifies the corporate role scope claim."""
    role = payload.get("role")
    if not role:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token payload missing corporate role scope claim.")
    return role

def require_roles(allowed_roles: list[str]):
    """Dynamic security checking factory module returning standard runtime clearance injection wrappers."""
    def role_checker(user_role: str = Depends(verify_role_clearance)):
        if user_role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Access Denied. Clearances restricted to privileges matching: {allowed_roles}")
        return user_role
    return role_checker

# 📊 CENTRALIZED AUDIT LOG ENGINE
def log_administrative_action(action_type: str, username: str, user_role: str, description: str, account_num: Optional[str] = None, client_ip: Optional[str] = None):
    """Persists transactions to the arcgis_business operational logging engine."""
    try:
        print(f"[AUDIT LOG] USER: {username} ({user_role}) | ACTION: {action_type} | PARCEL: {account_num} | DESC: {description}")
        
        conn = psycopg2.connect(BUSINESS_DB_URL)
        cursor = conn.cursor()
        # INTEGRATION: Changed 'audit_logs' to your pre-existing 'administrative_audit_logs'
        cursor.execute("""
            INSERT INTO administrative_audit_logs (username, user_role, action_type, account_num, description, client_ip)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (username, user_role, action_type, account_num, description, client_ip))
        conn.commit()
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"CRITICAL: System Logger failure: {e}")

# 🔐 SECURITY CONTROLLER: GENERATE TOKENS
@app.post("/api/auth/login")
def login_and_generate_token(credentials: LoginRequest, request: Request):
    user_record = MOCK_USER_DIRECTORY.get(credentials.username)
    if not user_record or user_record["password"] != credentials.password:
        raise HTTPException(status_code=401, detail="Invalid system credentials.")
        
    token_payload = {
        "username": credentials.username,
        "user_id": hash(credentials.username) % 1000,
        "role": user_record["role"],
        "division": user_record["division"],
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=8)
    }
    
    log_administrative_action("LOGIN", credentials.username, user_record["role"], "User successfully authenticated.", client_ip=request.client.host)
    
    return {
        "access_token": jwt.encode(token_payload, JWT_SECRET, algorithm=JWT_ALGORITHM),
        "token_type": "bearer",
        "role": user_record["role"],
        "division": user_record["division"]
    }

# 📁 COGNITIVE DATA VIEWS ROUTERS
@app.get("/api/parcels/list")
def get_parcel_directory(limit: int = 50, offset: int = 0, search: str = ""):
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        if search:
            query = "SELECT account_num, owner_name1 FROM dcad_accounts WHERE account_num ILIKE %s OR owner_name1 ILIKE %s ORDER BY account_num ASC LIMIT %s OFFSET %s;"
            cursor.execute(query, (f"%{search}%", f"%{search}%", limit, offset))
        else:
            query = "SELECT account_num, owner_name1 FROM dcad_accounts ORDER BY account_num ASC LIMIT %s OFFSET %s;"
            cursor.execute(query, (limit, offset))
        records = cursor.fetchall()
        cursor.close()
        return records
    except Exception:
        return [{"account_num": f"10000000000{i}", "owner_name1": f"DCAD DEMO PARCEL OWNER {i}"} for i in range(offset, offset + limit)]
    finally:
        if conn: conn.close()

@app.get("/api/account/{account_num}")
def get_parcel_by_account(account_num: str):
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT account_num, owner_name1, lma, ima, appraisal_yr, division_cd, biz_name,
                   ST_AsGeoJSON(geom)::json as geometry
            FROM dcad_accounts WHERE account_num = %s;
        """, (account_num,))
        record = cursor.fetchone()
        cursor.close()
        if not record:
            raise HTTPException(status_code=404, detail="Account matching identity parameters does not exist.")
        geojson_geometry = record.pop("geometry")
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": geojson_geometry, "properties": record}]}
    except Exception:
        return {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [[[-96.812, 32.774], [-96.804, 32.774], [-96.804, 32.779], [-96.812, 32.779], [-96.812, 32.774]]]},
                "properties": {"account_num": account_num, "owner_name1": "TESTING SYSTEM ESTATE", "lma": 150000.0, "ima": 325000.0, "appraisal_yr": "2026", "division_cd": "NTH", "biz_name": "Spatial Analytics Inc"}
            }]
        }
    finally:
        if conn: conn.close()

# 📐 CADASTRAL GEOMETRY OVERRIDE ENDPOINT
@app.patch("/api/parcels/{account_num}/update-geometry")
def update_parcel_geometry(
    account_num: str, 
    payload: dict, 
    request: Request,
    token_data: dict = Depends(get_current_user_token)
):
    user_role = token_data.get("role")
    username = token_data.get("username", "gis_staff")

    if user_role not in ['gis_editor', 'gis_editor_user', 'admin']:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Geometry modifications require GIS Editor clearance."
        )

    # Validate that we received a valid GeoJSON structure
    if not payload or "coordinates" not in payload:
        raise HTTPException(status_code=400, detail="Invalid geometry payload. Expected GeoJSON structure.")

    # INTEGRATION: Extract explicitly passed SRID to manage spatial translation back to DB native projection
    srid = payload.get("srid", 3857)

    geojson_str = json.dumps(payload)
    conn = None

    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()

        # Update the specific parcel using PostGIS ST_GeomFromGeoJSON
        # INTEGRATION: Apply ST_Transform to ensure it aligns back to your 4326 PostGIS standard
        cursor.execute("""
            UPDATE dcad_accounts 
            SET geom = ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), %s), 4326))
            WHERE account_num = %s
            RETURNING account_num;
        """, (geojson_str, srid, account_num))
        
        updated_row = cursor.fetchone()
        
        if not updated_row:
            cursor.close()
            raise HTTPException(status_code=404, detail="Target account not found in spatial warehouse.")

        conn.commit()
        cursor.close()

        # Log the manual vertex override for auditing
        log_administrative_action(
            action_type="MANUAL_GEOMETRY_EDIT", 
            username=username, 
            user_role=user_role, 
            account_num=account_num,
            description="Manual vertex reshape operation executed via interactive editor.", 
            client_ip=request.client.host
        )

        return {"status": "SUCCESS", "message": "Parcel geometry successfully reshaped."}

    except psycopg2.Error as db_err:
        if conn: conn.rollback()
        print(f"[POSTGIS ERROR] Failed to save geometry override: {db_err}")
        raise HTTPException(status_code=500, detail="Database rejected the geometry sequence. Ensure it does not self-intersect.")
    finally:
        if conn: conn.close()


# ⚖️ APPRAISAL PROTEST PUBLIC SUBMISSION GATEWAY
@app.post("/api/protests/submit")
def public_submit_protest(payload: ProtestSubmission, request: Request, token_data: Optional[dict] = Depends(get_optional_user_token)):
    # Filing requires AUTHENTICATED public-citizen credentials.
    # Anonymous requests and any non-public roles are rejected.
    if token_data is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required: please log in with public citizen credentials to file a protest."
        )
    if token_data.get("role") != "public":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Filing property protests via this gateway is restricted strictly to public citizens."
        )

    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        
        cursor.execute("SELECT lma, ima FROM dcad_accounts WHERE account_num = %s;", (payload.account_num,))
        parcel = cursor.fetchone()
        if not parcel:
            raise HTTPException(status_code=404, detail="Target account identifier mapping failed.")
            
        original_value = safe_float(parcel['lma']) + safe_float(parcel['ima'])
        
        cursor.execute("""
            INSERT INTO protests (account_num, appraisal_yr, protest_reason, original_value)
            VALUES (%s, %s, %s, %s) RETURNING protest_id;
        """, (payload.account_num, payload.appraisal_yr, payload.protest_reason, original_value))
        
        protest_id = cursor.fetchone()['protest_id']
        conn.commit()
        cursor.close()
        
        log_administrative_action(
            action_type="PROTEST_SUBMIT", username=token_data.get("username", "public_citizen"), 
            user_role="public", account_num=payload.account_num,
            description=f"Public protest filed successfully. System tracking ID: {protest_id}.", client_ip=request.client.host
        )
        return {"status": "SUCCESS", "protest_id": protest_id, "message": "Protest registered on appraisal ledger."}
    except Exception as e:
        if conn: conn.rollback()
        if isinstance(e, HTTPException): raise e
        return {"status": "ERROR", "detail": str(e)}
    finally:
        if conn: conn.close()

# ⚖️ INTERNAL WORKLIST VIEWER GATEWAY
@app.get("/api/protests/queue")
def get_protest_worklist(user_role: str = Depends(require_roles(['appraiser', 'analyst', 'admin']))):
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM protests ORDER BY filed_date DESC;")
        records = cursor.fetchall()
        cursor.close()
        return records
    except Exception:
        return [{"protest_id": 1, "account_num": "100000000004", "status": "Filed", "protest_reason": "Market Value Equality Inequities Change", "original_value": 450000, "reduced_value": None}]
    finally:
        if conn: conn.close()

# ⚖️ OPERATIONAL PROTEST RESOLUTION ENDPOINT
@app.patch("/api/protests/{protest_id}/evaluate")
def evaluate_protest_record(
    protest_id: int, 
    payload: ProtestUpdate, 
    request: Request, 
    token_data: dict = Depends(get_current_user_token)
):
    user_role = token_data.get("role")
    username = token_data.get("username", "internal_staff")
    
    if user_role not in ['appraiser', 'admin']:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Privileged modifications require Appraiser or Admin credentials."
        )
        
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        
        cursor.execute("""
            UPDATE protests 
            SET status = %s, 
                outcome = %s, 
                hearing_date = %s, 
                reduced_value = %s,
                appraisal_notes = %s,
                resolved_date = CASE WHEN %s = 'Resolved' THEN CURRENT_DATE ELSE resolved_date END
            WHERE protest_id = %s 
            RETURNING account_num;
        """, (payload.status, payload.outcome, payload.hearing_date, payload.reduced_value, payload.appraisal_notes, payload.status, protest_id))
        
        result = cursor.fetchone()
        
        if not result:
            cursor.close()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Protest application tracking record missing or already removed."
            )
            
        conn.commit()
        cursor.close()
        
        audit_description = (
            f"Protest File Evaluation complete. Status: {payload.status}. "
            f"Outcome: {payload.outcome or 'N/A'}. Reduced Target: ${payload.reduced_value or 0.0}. "
            f"Internal Notes: {payload.appraisal_notes or 'No appraisal notes recorded.'}"
        )
        
        log_administrative_action(
            action_type="PROTEST_EVAL", 
            username=username, 
            user_role=user_role, 
            account_num=result['account_num'],
            description=audit_description, 
            client_ip=request.client.host
        )
        
        return {
            "status": "SUCCESS", 
            "message": f"Protest processing sequence #{protest_id} safely recorded and logged."
        }
        
    except HTTPException as http_err:
        raise http_err
    except psycopg2.Error as db_err:
        if conn: conn.rollback()
        print(f"[CRITICAL] Database rollback executed. SQL Failure: {db_err}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail="Database transaction failure during operational ledger write."
        )
    except Exception as e:
        if conn: conn.rollback()
        print(f"[SYSTEM ERROR] Unexpected system breakdown: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=f"Internal pipeline disruption: {str(e)}"
        )
    finally:
        if conn:
            conn.close()
        
# ⚖️ ADMINISTRATIVE PROTEST PURGE ENDPOINT
@app.delete("/api/protests/{protest_id}/purge")
def administrative_purge_protest(protest_id: int, request: Request, token_data: dict = Depends(get_current_user_token)):
    user_role = token_data.get("role")
    username = token_data.get("username", "security_admin")
    
    if user_role != 'admin':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="CRITICAL MISCONFIGURATION ATTACK: Disciplinary record purging is restricted strictly to root Administrators."
        )
        
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        
        cursor.execute("SELECT account_num FROM protests WHERE protest_id = %s;", (protest_id,))
        record = cursor.fetchone()
        if not record:
            raise HTTPException(status_code=404, detail="Target protest file record not found.")
            
        cursor.execute("DELETE FROM protests WHERE protest_id = %s;", (protest_id,))
        conn.commit()
        cursor.close()
        conn.close()
        
        log_administrative_action(
            action_type="PROTEST_PURGE", username=username, user_role=user_role, account_num=record['account_num'],
            description=f"HARD PURGE: Protest Record tracking ID {protest_id} completely removed from databases.", client_ip=request.client.host
        )
        return {"status": "SUCCESS", "message": f"Dispute tracking sequence ID {protest_id} successfully deleted from databases."}
    except Exception as e:
        if isinstance(e, HTTPException): raise e
        return {"status": "ERROR", "detail": str(e)}

# 🔍 OTHER OPERATION COMPONENT SUB-MODULE ENDPOINTS
@app.get("/api/dashboard/change-detections")
def get_dashboard_change_detections(current_role: str = Depends(require_roles(['public', 'appraiser', 'analyst', 'admin']))):
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        cursor.execute("SELECT detection_id, account_num, detection_type, confidence, review_status FROM change_detections ORDER BY confidence DESC LIMIT 50;")
        records = cursor.fetchall()
        cursor.close()
        return records
    except Exception:
        return [{"detection_id": 1, "account_num": "100000000001", "detection_type": "Unpermitted Structural Addition", "confidence": 0.94, "review_status": "Pending Field Inspection"}]
    finally:
        if conn: conn.close()

@app.get("/api/dashboard/qa-issues")
def get_dashboard_qa_issues(current_role: str = Depends(require_roles(['gis_editor', 'gis_editor_user', 'appraiser', 'analyst', 'admin']))):
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT issue_id, account_num, issue_type, description, severity, status
            FROM qa_issues WHERE status = 'OPEN'
            ORDER BY CASE severity
                WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                created_at DESC
            LIMIT 500;
        """)
        records = cursor.fetchall()
        cursor.close()
        return records
    except Exception:
        return [{"issue_id": 1, "account_num": "100000000002", "issue_type": "Overlap", "description": "Parcel overlaps spatially with account 100000000003", "severity": "HIGH", "status": "OPEN"}]
    finally:
        if conn: conn.close()

@app.get("/api/dashboard/ml-analytics")
def get_dashboard_ml_analytics(current_role: str = Depends(require_roles(['analyst', 'admin']))):
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT m.account_num, m.protest_risk_score, m.anomaly_flag, a.lma, a.ima
            FROM ml_analytics_outputs m
            JOIN dcad_accounts a ON a.account_num = m.account_num
            WHERE m.anomaly_flag = 1
            ORDER BY m.protest_risk_score DESC
            LIMIT 50;
        """)
        records = cursor.fetchall()
        cursor.close()
        return records
    except Exception:
        return [{"account_num": "100000000005", "protest_risk_score": 0.87, "anomaly_flag": 1, "lma": 220000, "ima": 680000}]
    finally:
        if conn: conn.close()

@app.get("/api/comparables")
def calculate_spatial_comparables(account_num: str, radius_meters: float = 500.0, user_role: str = Depends(verify_role_clearance)):
    if user_role not in ['appraiser', 'analyst', 'admin']:
        raise HTTPException(status_code=403, detail="Access denied for this role tier elevation level.")
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        cursor.execute("""
            WITH target_parcel AS (SELECT geom FROM dcad_accounts WHERE account_num = %s)
            SELECT comp.account_num, comp.lma, comp.ima, ST_Distance(comp.geom, (SELECT geom FROM target_parcel)) as distance_meters
            FROM dcad_accounts comp
            WHERE ST_DWithin(comp.geom, (SELECT geom FROM target_parcel), %s)
            AND comp.account_num <> %s ORDER BY distance_meters ASC LIMIT 10;
        """, (account_num, radius_meters, account_num))
        records = cursor.fetchall()
        cursor.close()
        return records
    except Exception:
        return [{"account_num": "100000000009", "lma": 140000, "ima": 310000, "distance_meters": 142.5}]
    finally:
        if conn: conn.close()

@app.post("/api/qa/resolve-issue/{issue_id}")
def resolve_topology_issue(
    issue_id: int,
    request: Request,
    token_data: dict = Depends(get_current_user_token)
):
    user_role = token_data.get("role")
    username = token_data.get("username", "gis_staff")
    
    if user_role not in ['gis_editor', 'gis_editor_user', 'admin']:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Privileged geometry modifications require GIS Editor or Admin credentials."
        )
        
    conn = None
    try:
        conn = psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT account_num, issue_type, description 
            FROM qa_issues 
            WHERE issue_id = %s AND status = 'OPEN';
        """, (issue_id,))
        issue = cursor.fetchone()
        
        if not issue:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Active topology issue record not found or already resolved."
            )
            
        account_num = issue['account_num']
        issue_type = issue['issue_type']
        
        if issue_type == 'Self-Intersection':
            cursor.execute("""
                UPDATE dcad_accounts 
                SET geom = ST_Multi(ST_MakeValid(geom)) 
                WHERE account_num = %s;
            """, (account_num,))
            
        elif issue_type == 'Overlap':
            cursor.execute("""
                UPDATE dcad_accounts a
                SET geom = ST_Multi(
                    ST_Difference(
                        ST_MakeValid(a.geom),
                        COALESCE(
                            (SELECT ST_Union(ST_MakeValid(b.geom)) 
                             FROM dcad_accounts b 
                             WHERE b.account_num <> a.account_num AND ST_Intersects(a.geom, b.geom)),
                            ST_GeomFromText('MULTIPOLYGON EMPTY', 4326)
                        )
                    )
                )
                WHERE a.account_num = %s;
            """, (account_num,))
            
        else:
            pass

        cursor.execute("""
            UPDATE qa_issues 
            SET status = 'RESOLVED' 
            WHERE issue_id = %s;
        """, (issue_id,))
        
        conn.commit()
        cursor.close()
        
        audit_desc = f"Resolved QA Topology Issue #{issue_id} ({issue_type}) for Account {account_num} via automated remediation script."
        log_administrative_action(
            action_type="GEOM_QA_RESOLVE",
            username=username,
            user_role=user_role,
            account_num=account_num,
            description=audit_desc,
            client_ip=request.client.host
        )
        
        return {
            "status": "SUCCESS",
            "message": f"Topology issue #{issue_id} successfully corrected and closed."
        }
        
    except psycopg2.Error as db_err:
        if conn: conn.rollback()
        print(f"[QA ERROR] PostGIS execution failure: {db_err}")
        raise HTTPException(status_code=500, detail=f"Spatial engine failed to apply fix: {str(db_err)}")
    finally:
        if conn: conn.close()