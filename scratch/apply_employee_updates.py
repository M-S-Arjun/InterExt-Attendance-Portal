import json
import re
import os

raw_data = """
2014	NIJI MANOJ	Daily Wages Staff	15,000.00	576.92	Workshop Assistant	Interext
2015	REKHA MADHU	Daily Wages Staff	15,000.00	576.92	Workshop Assistant	Interext
2028	RAJI KANNAN	Daily Wages Staff	15,000.00	576.92	Workshop Assistant	Interext
2038	James TM	Daily Wages Staff	25,000.00	961.54	Sales Executive	Interext
2046	Sunil. C. M	Daily Wages Staff	26,000.00	1,000.00	Office Attandent	Interext
2048	Ratheesh K S	Daily Wages Staff	38,000.00	1,461.54	Workshop Assistant	Interext
2090	Binu Ajith	Daily Wages Staff	16,000.00	615.38	Office Attandent	City Advertisers
2052	Raju Rana	Daily Wages Staff	23,500.00	903.85	Workshop Assistant	Interext
2053	Devadas E K	Daily Wages Staff	33,000.00	1,269.23	Workshop Assistant	City Advertisers
2056	Raj Kumar Rana	Daily Wages Staff	22,100.00	850.00	Workshop Assistant	Interext
2058	Akash	Daily Wages Staff	30,000.00	1,153.85	Workshop Assistant	City Advertisers
2067	Pappu Kumar Rana	Daily Wages Staff	27,000.00	1,038.46	Workshop Assistant	Interext
2081	Bimal Rana	Daily Wages Staff	15,000.00	576.92	Workshop Assistant	Interext
2083	Ajmal K H	Daily Wages Staff	26,000.00	1,000.00	Workshop Assistant	Interext
2060	Ratheesh P R	Daily Wages Staff - Welder		1,300.00	welder signage	Interext
2061	Joshy	Daily Wages Staff - Welder		1,350.00	welder signage	Interext
2066	Arun P madhu	Daily Wages Staff - Welder		1,300.00	welder signage	Interext
2049	Rahul R Nair	Daily Wages Staff 	26,000.00	1,000.00	Workshop Assistant	Interext
1002	PRATHEESH K S	Office Staff	57,000.00	1,900.00	Project Manager	Interext
1003	AJEESH VIJAYAN	Office Staff	32,000.00	1,066.67	Material Sourcing Manager	Interext
1004	REBEESH K S	Office Staff	38,000.00	1,266.67	Finance & Accounts Head	Interext
1009	SHYAM MURALI	Office Staff	41,000.00	1,366.67	Material & Cost Manager	Interext
2001	SHINODH N T	Office Staff	50,000.00	1,666.67	Poject Manager	Interext
2006	AKHIL P KUMAR	Office Staff	36,000.00	1,200.00	Senior Graphic Designer	Interext
2008	SHAHANA JABBAR	Office Staff	30,000.00	1,000.00	Senior Graphic Designer	Interext
2010	BINDHU JOSE	Office Staff	21,000.00	700.00	Accountant	City Advertisers
2025	PRASANTH E.M	Office Staff	31,000.00	1,033.33	Site Supervisor	Interext
2027	GEORGE THOMAS	Office Staff	39,000.00	1,300.00	Senior Interior & Exterior Designer	Interext
2029	ANADHU SUNIL	Office Staff	25,000.00	833.33	Junior Machine Operator	Interext
2032	GOKUL K	Office Staff	27,000.00	900.00	Interior& Exterior Designer	City Advertisers
2033	NOURIN SHAJI	Office Staff	20,000.00	666.67	Interior& Exterior Designer	City Advertisers
2036	Sineesh Sasi	Office Staff	29,000.00	966.67	Interior& Exterior Designer	Interext
2037	Manu Mahesh	Office Staff	40,000.00	1,333.33	Sales Lead	Interext
2039	Ajith Reghunath	Office Staff	18,000.00	600.00	Graphic Designer	City Advertisers
2041	Niranjan Bose	Office Staff	26,000.00	866.67	Graphic Designer	Interext
2042	Sukanto Mishal	Office Staff	40,000.00	1,333.33	CNC Machine Operator	Interext
2044	RAHUL SUNDARAN	Office Staff	35,000.00	1,166.67	Lead Data Coordinator	Interext
2045	Stephin Pious	Office Staff	25,000.00	833.33	Driver	Interext
2051	Siju Thomas	Office Staff	26,000.00	866.67	Site Supervisor	Interext
2054	Mahin KJ	Office Staff	27,000.00	900.00	Driver	Interext
2064	Sreelakshmi R	Office Staff	16,000.00	533.33	Admin & Project Coordinator	City Advertisers
2069	Abhishek Shaji	Office Staff	14,000.00	466.67	Graphic Designer	City Advertisers
2071	Remanan N N	Office Staff	60,000.00	2,000.00	Supervisor Welder	Interext
2072	Vijesh A V	Office Staff	30,000.00	1,000.00	Senior Welder	Interext
2075	Rakesh Sadhukha	Office Staff	40,000.00	1,333.33	Senior Machine Operator	Interext
2076	Sona Francis	Office Staff	18,000.00	600.00	Graphic Designer	City Advertisers
2078	Anusree Subramanian	Office Staff	15,000.00	500.00	Admin & Project Coordinator	City Advertisers
2080	Alex Rajan	Office Staff	20,000.00	666.67	Project Manager	Interext
2084	Rahul Das	Office Staff	22,000.00	733.33	Driver	Interext
2085	Anish Viswanathan	Office Staff	22,000.00	733.33	Driver	Interext
2086	Gokul Krishnan  E V	Office Staff	15,000.00	500.00	Site Supervisor	Interext
2087	M S Arjun	Office Staff	25,000.00	833.33	Software Developer	Interext
2088	Ramsy Rasheed	Office Staff	25,000.00	833.33	Accountant	Interext
2089	Abin Mathew	Office Staff	22,000.00	733.33	Driver	Interext
2092	Neethu Vijayan	Office Staff		0.00	Admin & Project Coordinator	City Advertisers
IN048	Aneesh Ahammed	Welders		1,100.00	Welder	Interext
IN049	Faiyaj Ansari	Welders		900.00	Welder	Interext
IN053	Sunil Aliyar	Welders		1,350.00	Welder	Interext
IN054	Sreeraj V S	Welders		1,050.00	Welder	Interext
IN055	Mohammed Gulfam	Welders		1,200.00	Welder	Interext
IN056	Sumesh B	Welders		1,300.00	Welder	Interext
IN058	Tufail Alam Danish	Welders		900.00	Welder	Interext
IN060	Sandeep C	Welders		1,200.00	Welder	Interext
IN061	Arun George	Welders		1,200.00	Welder	Interext
IN063	Akhil AK	Welders		1,300.00	Welder	Interext
IN064	Anandhu Raj	Welders		1,050.00	Welder	Interext
IN065	Anoop (Ancil K Grace)	Welders		1,350.00	Welder	Interext
IN066	Gopal (soma)	Welders		1,050.00	Welder	Interext
IN067	Sabu (Joseph Antony)	Welders		1,300.00	Welder	Interext
IN069	Subodh Sha	Welders		1,000.00	Welder	Interext
IN071	Anil Rana	Welders		1,050.00	Welder	Interext
IN071	Sunil Rana	Welders		1,200.00	Welder	Interext
IN073	Samshad Aalam	Welders		900.00	Welder	Interext
IN074	Aamil	Welders		1,200.00	Welder	Interext
IN075	Sanjaya behara	Welders		1,200.00	Welder	Interext
""".strip().splitlines()

def clean_name(name):
    name = re.sub(r'\s+', ' ', name.strip())
    
    def title_word(word):
        if not word:
            return ""
        prefix = ""
        suffix = ""
        if word.startswith('('):
            prefix = '('
            word = word[1:]
        if word.endswith(')'):
            suffix = ')'
            word = word[:-1]
            
        if len(word) > 0:
            # Check for dots to handle initials like C.M
            dot_parts = word.split('.')
            title_dots = []
            for part in dot_parts:
                if part:
                    title_dots.append(part[0].upper() + part[1:].lower())
                else:
                    title_dots.append("")
            word = ".".join(title_dots)
        return prefix + word + suffix

    words = name.split(' ')
    return " ".join([title_word(w) for w in words])

parsed = []
for line in raw_data:
    if not line.strip():
        continue
    parts = [p.strip() for p in line.split("\t")]
    if len(parts) < 6:
        parts = [p.strip() for p in re.split(r'\t+', line)]
    
    uid = parts[0]
    raw_name = parts[1]
    name = clean_name(raw_name)
    mode = parts[2]
    
    if len(parts) == 6:
        monthly_wage = 0.0
        daily_rate = parts[3]
        designation = parts[4]
        pay_mode = parts[5]
    else:
        monthly_wage = parts[3]
        daily_rate = parts[4]
        designation = parts[5]
        pay_mode = parts[6] if len(parts) > 6 else ""
        
    # Coerce rate numbers
    def to_float(val):
        if not val:
            return 0.0
        # Remove commas and convert
        clean_val = val.replace(",", "").strip()
        try:
            return float(clean_val)
        except ValueError:
            return 0.0
            
    parsed.append({
        "userId": uid,
        "name": name,
        "modeOfWork": mode,
        "monthlyWage": to_float(monthly_wage),
        "dailyRate": to_float(daily_rate),
        "designation": designation,
        "paymentMode": pay_mode
    })

print(f"Parsed {len(parsed)} employees.")

# Read DB
db = json.load(open("data.json", encoding="utf-8"))
existing_employees = db["employees"]

# We will match existing employees by:
# 1. Exact userId (except for Sunil Rana who might be IN071/IN072)
# 2. Match by Name (case insensitive, ignoring dots and spaces)
def get_match_key(name):
    return re.sub(r'[^a-zA-Z]', '', name).lower()

existing_by_uid = {e["userId"]: e for e in existing_employees}
existing_by_name = {get_match_key(e["name"]): e for e in existing_employees}

# Special mapping for Sunil Rana (who is IN071 in user list but IN072 in DB)
sunil_key = get_match_key("Sunil Rana")
if sunil_key in existing_by_name:
    sunil_emp = existing_by_name[sunil_key]
    print(f"Sunil Rana matches in DB with ID: {sunil_emp['userId']}")

updated_list = []
for p in parsed:
    # Try finding match in existing
    match = None
    if p["userId"] in existing_by_uid:
        match = existing_by_uid[p["userId"]]
    elif get_match_key(p["name"]) in existing_by_name:
        match = existing_by_name[get_match_key(p["name"])]
        print(f"Matched by name: '{p['name']}' (User ID change: {match['userId']} -> {p['userId']})")
        
    if match:
        # Merge parsed details into existing object to preserve other fields
        merged = dict(match)
        merged["userId"] = p["userId"]
        merged["name"] = p["name"]
        merged["modeOfWork"] = p["modeOfWork"]
        merged["monthlyWage"] = p["monthlyWage"]
        merged["dailyRate"] = p["dailyRate"]
        merged["designation"] = p["designation"]
        merged["paymentMode"] = p["paymentMode"]
        
        # Calculate hourlyRate dynamically based on shift duration
        settings = db.get("settings", {})
        F = settings.get("standardFullDayHours", 8.0)
        if merged.get("shiftStart") and merged.get("shiftEnd"):
            try:
                sh_start = merged["shiftStart"]
                sh_end = merged["shiftEnd"]
                h_start, m_start = map(int, sh_start.split(':'))
                h_end, m_end = map(int, sh_end.split(':'))
                shift_minutes = (h_end * 60 + m_end) - (h_start * 60 + m_start)
                if shift_minutes < 0:
                    shift_minutes += 24 * 60
                shift_hours = shift_minutes / 60.0
                F = (shift_hours - 1.0) if shift_hours >= 9.0 else shift_hours
            except Exception as e:
                pass
        
        if F > 0:
            merged["hourlyRate"] = round(merged["dailyRate"] / F, 2)
        else:
            merged["hourlyRate"] = round(merged["dailyRate"] / 8.0, 2)
            
        updated_list.append(merged)
    else:
        # Create a new employee object
        print(f"Creating NEW employee record for '{p['name']}' (ID: {p['userId']})")
        new_id = f"emp_{p['userId']}" if p["userId"].isdigit() else f"emp_{p['userId'].lower()}"
        new_emp = {
            "id": new_id,
            "name": p["name"],
            "phone": "",
            "status": "active",
            "dailyRate": p["dailyRate"],
            "hourlyRate": round(p["dailyRate"] / 8.0, 2),
            "siteId": "site_a",
            "userId": p["userId"],
            "modeOfWork": p["modeOfWork"],
            "createdAt": "2026-06-11T12:00:00.000Z",
            "shiftStart": "09:00",
            "shiftEnd": "18:00",
            "shiftGroup": "09:00:00 to 18:00:00",
            "monthlyWage": p["monthlyWage"],
            "designation": p["designation"],
            "paymentMode": p["paymentMode"]
        }
        updated_list.append(new_emp)

# Report deletions
new_uids = {p["userId"] for p in parsed}
deleted = [e for e in existing_employees if e["userId"] not in new_uids and get_match_key(e["name"]) not in {get_match_key(p["name"]) for p in parsed}]
print("\n--- DELETED EMPLOYEES ---")
for d in deleted:
    print(f"Deleting employee: {d['userId']} - {d['name']}")

# Save changes to data.json
db["employees"] = updated_list
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(db, f, indent=2)

print("\nSuccessfully updated employee directory!")
