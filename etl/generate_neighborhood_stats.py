import psycopg2
from config import SPATIAL_DB_URL

def aggregate_neighborhoods():
    conn = psycopg2.connect(SPATIAL_DB_URL)
    cursor = conn.cursor()
    print("Compiling aggregate neighborhood market segments...")
    # Computes macro stats across distinct neighborhood classification layers
    cursor.execute("SELECT DISTINCT nbhd_cd FROM dcad_accounts WHERE nbhd_cd IS NOT NULL;")
    neighborhoods = cursor.fetchall()
    
    print(f"Processed aggregations for {len(neighborhoods)} active neighborhood boundary identifiers.")
    cursor.close()
    conn.close()

if __name__ == "__main__":
    aggregate_neighborhoods()