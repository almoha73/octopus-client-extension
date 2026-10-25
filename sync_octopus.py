#!/usr/bin/env python3
"""
Synchronise les mesures Octopus Energy des 2 logements vers le Google Sheet
via l'URL Web App Google Apps Script (doPost).
"""
import json
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "all_measurements.json"


def parse_property_rows(measurements, is_hphc=False):
    rows = []
    for m in measurements:
        iso_date = m["startAt"][:10]
        kwh_total = round(float(m["value"]), 3)
        stats = (m.get("metaData") or {}).get("statistics") or []
        abo_eur = 0.0
        base_eur = 0.0
        hp_kwh = 0.0
        hc_kwh = 0.0
        hp_eur = 0.0
        hc_eur = 0.0
        for s in stats:
            lbl = s.get("label")
            amt = float((s.get("costInclTax") or {}).get("estimatedAmount") or 0.0) / 100.0
            val = float(s.get("value") or 0.0)
            if lbl == "ABONNEMENT":
                abo_eur += amt
            elif lbl == "Base":
                base_eur += amt
            elif lbl == "Heures Pleines":
                hp_kwh += val
                hp_eur += amt
            elif lbl == "Heures Creuses":
                hc_kwh += val
                hc_eur += amt
        if is_hphc:
            rows.append([
                iso_date,
                round(kwh_total, 3),
                round(hp_kwh, 3),
                round(hc_kwh, 3),
                round(hp_eur, 4),
                round(hc_eur, 4),
                round(abo_eur, 4),
            ])
        else:
            rows.append([
                iso_date,
                round(kwh_total, 3),
                round(base_eur, 4),
                round(abo_eur, 4),
            ])
    return rows


DEFAULT_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyXUPxpUlzVcXnb_c2nfffleF-yaRulmOPCkysjVOuol8JmBOaFdA4HZdYEuXgso9IH/exec"


def main():
    webapp_url = sys.argv[1].strip() if len(sys.argv) >= 2 else DEFAULT_WEBAPP_URL
    raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))

    payload = {
        "lapleau": parse_property_rows(raw["717277"]["measurements"], is_hphc=False),
        "bordeaux": parse_property_rows(raw["78601"]["measurements"], is_hphc=True),
    }

    req = urllib.request.Request(
        webapp_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        print(resp.read().decode("utf-8"))


if __name__ == "__main__":
    main()
