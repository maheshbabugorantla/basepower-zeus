"""Apply one SQL migration file to POSTGRES_URL_NON_POOLING in a single
transaction (lock_timeout 5s). Usage: python scripts/apply_sql.py <file.sql>"""
import os
import sys

import psycopg

with psycopg.connect(os.environ["POSTGRES_URL_NON_POOLING"], prepare_threshold=None) as conn:
    conn.execute("set lock_timeout = '5s'")
    conn.execute(open(sys.argv[1]).read())
print("applied OK")
