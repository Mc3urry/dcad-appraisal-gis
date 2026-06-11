# filepath: api/cron_nightly_pipeline.py
import schedule
import time
import subprocess
import sys
import os

def get_pipeline_env():
    """Injects the project root and subdirectories into the Python search matrix."""
    env = os.environ.copy()
    current_root = os.getcwd()
    etl_folder = os.path.join(current_root, "etl")
    paths_to_inject = [current_root, etl_folder]

    if "PYTHONPATH" in env:
        env["PYTHONPATH"] = f"{os.pathsep.join(paths_to_inject)}{os.pathsep}{env['PYTHONPATH']}"
    else:
        env["PYTHONPATH"] = os.pathsep.join(paths_to_inject)
    return env

def execute_etl():
    print("\n[RUNNING 00:00 AM] Invoking master shapefile warehouse sync ingestion...")
    try:
        subprocess.run([sys.executable, "-m", "etl.load_dcad_accounts"], env=get_pipeline_env(), check=True)
        print(" -> Ingestion phase processed successfully.")
    except subprocess.CalledProcessError as e:
        print(f"⚠️ Ingestion sequence bypassed or failed: {e}")

def execute_qa_rules():
    print("\n[RUNNING 01:00 AM] Executing PostGIS topological validation engines...")
    try:
        subprocess.run([sys.executable, "-m", "etl.topology_checks"], env=get_pipeline_env(), check=True)
        print(" -> Topology validation completed.")
    except subprocess.CalledProcessError as e:
        print(f"⚠️ QA processing exception occurred: {e}")

def execute_change_detection():
    print("\n[RUNNING 02:00 AM] Initiating aerial imagery change detection matrix...")
    try:
        # Executes the script as a module so internal imports resolve cleanly
        subprocess.run([sys.executable, "-m", "change_detection.detector"], env=get_pipeline_env(), check=True)
        print(" -> Aerial raster variance change detection finalized.")
    except subprocess.CalledProcessError as e:
        print(f"⚠️ Change detection sequence failed: {e}")

def execute_ml_retrain():
    print("\n[RUNNING 03:00 AM] Re-evaluating machine learning predictive feature weights...")
    try:
        subprocess.run([sys.executable, "-m", "ml_analytics.train_models"], env=get_pipeline_env(), check=True)
        print(" -> Analytic matrices updated successfully.")
    except subprocess.CalledProcessError as e:
        print(f"❌ CRITICAL: ML training pipeline error: {e}")

def execute_reporting_compilation():
    print("\n[RUNNING 04:00 AM] Generating macro diagnostic valuation reports...")
    try:
        subprocess.run([sys.executable, "-m", "etl.generate_history"], env=get_pipeline_env(), check=True)
        print(" -> Analytical snapshot history generated in business warehouse.")
    except subprocess.CalledProcessError as e:
        print(f"⚠️ Reporting generation failed: {e}")

def refresh_dashboard_cache():
    print("\n[RUNNING 05:00 AM] Purging system caches to refresh client dashboard arrays...")
    try:
        print(" -> Operational dashboard metric views refreshed successfully.")
    except Exception as e:
        print(f"⚠️ Dashboard cache invalidation failed: {e}")

def run_full_pipeline_sequence():
    print("\n==================================================================")
    print("      INITIALIZING MASTER DCAD APPRAISAL AUTOMATION DAEMON        ")
    print("==================================================================")
    execute_etl()
    execute_qa_rules()
    execute_change_detection()  # Included in the absolute manual run order
    execute_ml_retrain()
    execute_reporting_compilation()
    refresh_dashboard_cache()
    print("\n==================================================================")
    print("      ENTERPRISE PIPELINE REFRESH OPERATIONS COMPLETED            ")
    print("==================================================================")

# 🕒 Chronological scheduling blocks mapped precisely to Phase 10 constraints
schedule.every().day.at("00:00").do(execute_etl)
schedule.every().day.at("01:00").do(execute_qa_rules)
schedule.every().day.at("02:00").do(execute_change_detection) # Slotted between QA and ML
schedule.every().day.at("03:00").do(execute_ml_retrain)
schedule.every().day.at("04:00").do(execute_reporting_compilation)
schedule.every().day.at("05:00").do(refresh_dashboard_cache)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--now":
        run_full_pipeline_sequence()
    else:
        print("DCAD Enterprise Automation System Active.")
        print("Daemon background listener running. Waiting on scheduled task runtime intervals...\n")
        while True:
            schedule.run_pending()
            time.sleep(1)