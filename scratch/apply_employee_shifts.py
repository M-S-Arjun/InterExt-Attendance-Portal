import json
import re
import os

raw_data = """
Daily Wages Staff	2014	NIJI MANOJ	15,000.00	576.92	Workshop Assistant	Interext	9:00	17:00	8:00
Daily Wages Staff	2015	REKHA MADHU	15,000.00	576.92	Workshop Assistant	Interext	9:00	17:00	8:00
Daily Wages Staff	2028	RAJI KANNAN	15,000.00	576.92	Workshop Assistant	Interext	9:00	17:00	8:00
Daily Wages Staff	2038	James TM	25,000.00	961.54	Sales Executive	Interext	9:00	18:00	9:00
Daily Wages Staff	2046	Sunil. C. M	26,000.00	1,000.00	Office Attandent	Interext	7:00	19:00	12:00
Daily Wages Staff	2048	Ratheesh K S	38,000.00	1,461.54	Workshop Assistant	Interext	9:00	19:00	10:00
Daily Wages Staff	2090	Binu Ajith	16,000.00	615.38	Office Attandent	City Advertisers	7:00	16:00	9:00
Daily Wages Staff	2052	Raju Rana	23,500.00	903.85	Workshop Assistant	Interext	9:00	19:00	10:00
Daily Wages Staff	2053	Devadas E K	33,000.00	1,269.23	Workshop Assistant	City Advertisers	9:00	19:00	10:00
Daily Wages Staff	2056	Raj Kumar Rana	22,100.00	850.00	Workshop Assistant	Interext	9:00	19:00	10:00
Daily Wages Staff	2058	Akash	30,000.00	1,153.85	Workshop Assistant	City Advertisers	9:00	19:00	10:00
Daily Wages Staff	2067	Pappu Kumar Rana	27,000.00	1,038.46	Workshop Assistant	Interext	9:00	19:00	10:00
Daily Wages Staff	2081	Bimal Rana	15,000.00	576.92	Workshop Assistant	Interext	9:00	19:00	10:00
Daily Wages Staff	2083	Ajmal K H	26,000.00	1,000.00	Workshop Assistant	Interext	9:00	19:00	10:00
Daily Wages Staff - Welder	2060	Ratheesh P R		1,300.00	welder signage	Interext	9:00	19:00	10:00
Daily Wages Staff - Welder	2061	Joshy		1,350.00	welder signage	Interext	9:00	19:00	10:00
Daily Wages Staff - Welder	2066	Arun P madhu		1,300.00	welder signage	Interext	9:00	19:00	10:00
Daily Wages Staff 	2049	Rahul R Nair	26,000.00	1,000.00	Workshop Assistant	Interext	9:00	19:00	10:00
Office Staff	1002	PRATHEESH K S	57,000.00	1,900.00	Project Manager	Interext	9:00	18:00	9:00
Office Staff	1003	AJEESH VIJAYAN	32,000.00	1,066.67	Material Sourcing Manager	Interext	9:00	18:00	9:00
Office Staff	1004	REBEESH K S	38,000.00	1,266.67	Finance & Accounts Head	Interext	9:00	18:00	9:00
Office Staff	1009	SHYAM MURALI	41,000.00	1,366.67	Material & Cost Manager	Interext	9:00	18:00	9:00
Office Staff	2001	SHINODH N T	50,000.00	1,666.67	Poject Manager	Interext	9:00	18:00	9:00
Office Staff	2006	AKHIL P KUMAR	36,000.00	1,200.00	Senior Graphic Designer	Interext	9:00	18:00	9:00
Office Staff	2008	SHAHANA JABBAR	30,000.00	1,000.00	Senior Graphic Designer	Interext	9:00	18:00	9:00
Office Staff	2010	BINDHU JOSE	21,000.00	700.00	Accountant	City Advertisers	9:00	17:00	8:00
Office Staff	2025	PRASANTH E.M	31,000.00	1,033.33	Site Supervisor	Interext	9:00	18:00	9:00
Office Staff	2027	GEORGE THOMAS	39,000.00	1,300.00	Senior Interior & Exterior Designer	Interext	9:00	18:00	9:00
Office Staff	2029	ANADHU SUNIL	25,000.00	833.33	Junior Machine Operator	Interext	9:00	19:00	10:00
Office Staff	2032	GOKUL K	27,000.00	900.00	Interior& Exterior Designer	City Advertisers	9:00	18:00	9:00
Office Staff	2033	NOURIN SHAJI	20,000.00	666.67	Interior& Exterior Designer	City Advertisers	9:00	18:00	9:00
Office Staff	2036	Sineesh Sasi	29,000.00	966.67	Interior& Exterior Designer	Interext	9:00	18:00	9:00
Office Staff	2037	Manu Mahesh	40,000.00	1,333.33	Sales Lead	Interext	9:00	18:00	9:00
Office Staff	2039	Ajith Reghunath	18,000.00	600.00	Graphic Designer	City Advertisers	9:00	18:00	9:00
Office Staff	2041	Niranjan Bose	26,000.00	866.67	Graphic Designer	Interext	9:00	18:00	9:00
Office Staff	2042	Sukanto Mishal	40,000.00	1,333.33	CNC Machine Operator	Interext	9:00	19:00	10:00
Office Staff	2044	RAHUL SUNDARAN	35,000.00	1,166.67	Lead Data Coordinator	Interext	9:00	18:00	9:00
Office Staff	2045	Stephin Pious	25,000.00	833.33	Driver	Interext	8:30	19:00	10:30
Office Staff	2051	Siju Thomas	26,000.00	866.67	Site Supervisor	Interext	9:00	18:00	9:00
Office Staff	2054	Mahin KJ	27,000.00	900.00	Driver	Interext	8:30	19:00	10:30
Office Staff	2064	Sreelakshmi R	16,000.00	533.33	Admin & Project Coordinator	City Advertisers	9:00	18:00	9:00
Office Staff	2069	Abhishek Shaji	14,000.00	466.67	Graphic Designer	City Advertisers	9:00	18:00	9:00
Office Staff	2071	Remanan N N	60,000.00	2,000.00	Supervisor Welder	Interext	9:00	18:00	9:00
Office Staff	2072	Vijesh A V	30,000.00	1,000.00	Senior Welder	Interext	9:00	18:00	9:00
Office Staff	2075	Rakesh Sadhukha	40,000.00	1,333.33	Senior Machine Operator	Interext	9:00	19:00	10:00
Office Staff	2076	Sona Francis	18,000.00	600.00	Graphic Designer	City Advertisers	9:00	18:00	9:00
Office Staff	2078	Anusree Subramanian	15,000.00	500.00	Admin & Project Coordinator	City Advertisers	9:00	18:00	9:00
Office Staff	2080	Alex Rajan	20,000.00	666.67	Project Manager	Interext	9:00	19:00	10:00
Office Staff	2084	Rahul Das	22,000.00	733.33	Driver	Interext	8:30	19:00	10:30
Office Staff	2085	Anish Viswanathan	22,000.00	733.33	Driver	Interext	8:30	19:00	10:30
Office Staff	2086	Gokul Krishnan  E V	15,000.00	500.00	Site Supervisor	Interext	9:00	18:00	9:00
Office Staff	2087	MS Arjun	25,000.00	833.33	Software Developer	Interext	9:00	18:00	9:00
Office Staff	2088	Ramsy Rasheed	25,000.00	833.33	Accountant	Interext	9:00	18:00	9:00
Office Staff	2089	Abin Mathew	22,000.00	733.33	Driver	Interext	8:30	19:00	10:30
Office Staff	2092	Neethu Vijayan		0.00	Admin & Project Coordinator	City Advertisers	9:00	18:00	9:00
Welders	IN048	Aneesh Ahammed		1,100.00	Welder	Interext	9:00	18:00	9:00
Welders	IN049	Faiyaj Ansari		900.00	Welder	Interext	9:00	18:00	9:00
Welders	IN053	Sunil Aliyar		1,350.00	Welder	Interext	9:00	18:00	9:00
Welders	IN054	Sreeraj V S		1,050.00	Welder	Interext	9:00	18:00	9:00
Welders	IN055	Mohammed Gulfam		1,200.00	Welder	Interext	9:00	18:00	9:00
Welders	IN056	Sumesh B		1,300.00	Welder	Interext	9:00	18:00	9:00
Welders	IN058	Tufail Alam Danish		900.00	Welder	Interext	9:00	18:00	9:00
Welders	IN060	Sandeep C		1,200.00	Welder	Interext	9:00	18:00	9:00
Welders	IN061	Arun George		1,200.00	Welder	Interext	9:00	18:00	9:00
Welders	IN063	Akhil AK		1,300.00	Welder	Interext	9:00	18:00	9:00
Welders	IN064	Anandhu Raj		1,050.00	Welder	Interext	9:00	18:00	9:00
Welders	IN065	Anoop (Ancil K Grace)		1,350.00	Welder	Interext	9:00	18:00	9:00
Welders	IN066	Gopal (soma)		1,050.00	Welder	Interext	9:00	18:00	9:00
Welders	IN067	Sabu (Joseph Antony)		1,300.00	Welder	Interext	9:00	18:00	9:00
Welders	IN069	Subodh Sha		1,000.00	Welder	Interext	9:00	18:00	9:00
Welders	IN071	Anil Rana		1,050.00	Welder	Interext	9:00	18:00	9:00
Welders	IN071	Sunil Rana		1,200.00	Welder	Interext	9:00	18:00	9:00
Welders	IN073	Samshad Aalam		900.00	Welder	Interext	9:00	18:00	9:00
Welders	IN074	Aamil		1,200.00	Welder	Interext	9:00	18:00	9:00
Welders	IN075	Sanjaya behara		1,200.00	Welder	Interext	9:00	18:00	9:00
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

def format_time(t):
    t = t.strip()
    if not t:
        return "09:00"
    parts = t.split(':')
    h = parts[0].zfill(2)
    m = parts[1].zfill(2) if len(parts) > 1 else "00"
    return f"{h}:{m}"

parsed = []
for line in raw_data:
    if not line.strip():
        continue
    parts = [p.strip() for p in line.split("\t")]
    if len(parts) < 10:
        parts = [p.strip() for p in re.split(r'\t+', line)]
    
    if len(parts) < 10:
        print("Failed to parse shift line:", line)
        continue
        
    mode = parts[0]
    uid = parts[1]
    name = clean_name(parts[2])
    monthly_wage = parts[3]
    daily_rate = parts[4]
    designation = parts[5]
    pay_mode = parts[6]
    start_time = format_time(parts[7])
    end_time = format_time(parts[8])
    
    def to_float(val):
        if not val:
            return 0.0
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
        "paymentMode": pay_mode,
        "shiftStart": start_time,
        "shiftEnd": end_time,
        "shiftGroup": f"{start_time}:00 to {end_time}:00"
    })

print(f"Parsed {len(parsed)} employee shifts.")

# Read DB
db = json.load(open("data.json", encoding="utf-8"))
existing_employees = db["employees"]

def get_match_key(name):
    return re.sub(r'[^a-zA-Z]', '', name).lower()

existing_by_uid = {e["userId"]: e for e in existing_employees}
existing_by_name = {get_match_key(e["name"]): e for e in existing_employees}

updated_list = []
for p in parsed:
    match = None
    if p["userId"] in existing_by_uid:
        match = existing_by_uid[p["userId"]]
    elif get_match_key(p["name"]) in existing_by_name:
        match = existing_by_name[get_match_key(p["name"])]
        
    if match:
        merged = dict(match)
        merged["userId"] = p["userId"]
        merged["name"] = p["name"]
        merged["modeOfWork"] = p["modeOfWork"]
        merged["monthlyWage"] = p["monthlyWage"]
        merged["dailyRate"] = p["dailyRate"]
        merged["designation"] = p["designation"]
        merged["paymentMode"] = p["paymentMode"]
        merged["shiftStart"] = p["shiftStart"]
        merged["shiftEnd"] = p["shiftEnd"]
        merged["shiftGroup"] = p["shiftGroup"]
        
        try:
            h_start, m_start = map(int, p["shiftStart"].split(':'))
            h_end, m_end = map(int, p["shiftEnd"].split(':'))
            shift_minutes = (h_end * 60 + m_end) - (h_start * 60 + m_start)
            if shift_minutes < 0:
                shift_minutes += 24 * 60
            shift_hours = shift_minutes / 60.0
            F = (shift_hours - 1.0) if shift_hours >= 9.0 else shift_hours
        except Exception as e:
            F = 8.0
            
        if F > 0:
            merged["hourlyRate"] = round(merged["dailyRate"] / F, 2)
        else:
            merged["hourlyRate"] = round(merged["dailyRate"] / 8.0, 2)
            
        updated_list.append(merged)
    else:
        new_id = f"emp_{p['userId']}" if p["userId"].isdigit() else f"emp_{p['userId'].lower()}"
        
        try:
            h_start, m_start = map(int, p["shiftStart"].split(':'))
            h_end, m_end = map(int, p["shiftEnd"].split(':'))
            shift_minutes = (h_end * 60 + m_end) - (h_start * 60 + m_start)
            if shift_minutes < 0:
                shift_minutes += 24 * 60
            shift_hours = shift_minutes / 60.0
            F = (shift_hours - 1.0) if shift_hours >= 9.0 else shift_hours
        except Exception as e:
            F = 8.0
            
        h_rate = round(p["dailyRate"] / F, 2) if F > 0 else round(p["dailyRate"] / 8.0, 2)
        
        new_emp = {
            "id": new_id,
            "name": p["name"],
            "phone": "",
            "status": "active",
            "dailyRate": p["dailyRate"],
            "hourlyRate": h_rate,
            "siteId": "site_a",
            "userId": p["userId"],
            "modeOfWork": p["modeOfWork"],
            "createdAt": "2026-06-11T12:00:00.000Z",
            "shiftStart": p["shiftStart"],
            "shiftEnd": p["shiftEnd"],
            "shiftGroup": p["shiftGroup"],
            "monthlyWage": p["monthlyWage"],
            "designation": p["designation"],
            "paymentMode": p["paymentMode"]
        }
        updated_list.append(new_emp)

# Report shifts summary updates without rupee symbol in print
print("\n--- SHIFT TIMINGS APPLIED ---")
for u in updated_list:
    print(f"Employee: {u['name']} | Shift: {u['shiftStart']} to {u['shiftEnd']} | Hourly Rate: Rs. {u['hourlyRate']}/hr (Daily Rate: Rs. {u['dailyRate']})")

# Save changes to data.json
db["employees"] = updated_list
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(db, f, indent=2)

print("\nSuccessfully updated employee directory shifts!")
