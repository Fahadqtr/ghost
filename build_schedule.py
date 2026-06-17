# -*- coding: utf-8 -*-
"""
بناء ملف إكسل لجدول الورديات وحجز الإجازات
قسم العمليات الجمركية - فريق الوردية
نظام: 6 أيام عمل + 4 أيام راحة (دورية) — بداية الدوام 2:00 عصراً
مع نظام حجز إجازات يكشف التعارض تلقائياً.
"""
import datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, NamedStyle
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule, CellIsRule
from openpyxl.utils import get_column_letter

# ------------------------------------------------------------------ بيانات
EMPLOYEES = [
    (1, "سالم شليويح المري", 392),
    (2, "فهد عبدالعزيز عبدالله", 2306),
    (3, "محمد ناصر الغانم", 4756),
    (4, "راشد عيسى التميمي", 4749),
    (5, "طلال زايد المري", 2927),
    (6, "منصور مبارك الجابري", 4522),
    (7, "محمد حمد الجابر", 3317),
    (8, "عبدالله سعد المهندي", 2424),
]

LEAVE_TYPES = ["سنوية", "عارض", "دورية", "مرضية", "مرافق مريض", "أخرى"]
STATUSES = ["معتمد", "قيد الانتظار", "مرفوض"]

# لون لكل نوع إجازة + حالات الجدول
COLORS = {
    "عمل":        "C6EFCE",   # أخضر فاتح
    "راحة":       "D9D9D9",   # رمادي
    "سنوية":      "FFE699",   # أصفر
    "عارض":       "F8CBAD",   # برتقالي
    "دورية":      "BDD7EE",   # أزرق فاتح
    "مرضية":      "FFC7CE",   # أحمر فاتح
    "مرافق مريض": "E2A9F3",   # بنفسجي
    "أخرى":       "FCE4D6",   # خوخي
}

PERIOD_START = datetime.date(2026, 6, 16)   # أول يوم في الجدول
DAYS = 31                                   # عدد الأيام المعروضة
AR_DAYS = ["الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]

L_FIRST, L_ROWS = 5, 100        # صفوف بيانات حجز الإجازات
L_LAST = L_FIRST + L_ROWS - 1

# ------------------------------------------------------------------ أنماط
THIN = Side(style="thin", color="9BB0C4")
MED = Side(style="medium", color="44546A")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
BORDER_M = Border(left=MED, right=MED, top=MED, bottom=MED)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
RIGHT = Alignment(horizontal="right", vertical="center", wrap_text=True)
HDR_FILL = PatternFill("solid", fgColor="44546A")
HDR_FONT = Font(name="Arial", bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(name="Arial", bold=True, color="1F3864", size=16)
SUB_FONT = Font(name="Arial", bold=True, color="44546A", size=12)
BASE_FONT = Font(name="Arial", size=11)


def style_header(cell):
    cell.fill = HDR_FILL
    cell.font = HDR_FONT
    cell.alignment = CENTER
    cell.border = BORDER


wb = Workbook()

# =================================================================  تعليمات
ws_info = wb.active
ws_info.title = "تعليمات"
ws_info.sheet_view.rightToLeft = True
ws_info.column_dimensions["A"].width = 3
ws_info.column_dimensions["B"].width = 95

rows = [
    ("title", "نظام جدول الورديات وحجز الإجازات"),
    ("sub", "قسم العمليات الجمركية — فريق الوردية"),
    ("", ""),
    ("h", "محتويات الملف (الأوراق بالأسفل):"),
    ("b", "1) الموظفون: قائمة أفراد الفريق وأرقامهم الوظيفية وبداية دورة العمل لكل فرد."),
    ("b", "2) جدول الورديات: تقويم يومي يحسب تلقائياً (عمل / راحة) ويُظهر الإجازات المعتمدة بالألوان."),
    ("b", "3) حجز الإجازات: تُسجَّل فيه طلبات الإجازة، ويكشف التعارض تلقائياً."),
    ("b", "4) الإعدادات والقوائم: ضبط بداية الدورة والحد الأدنى للتغطية وأنواع الإجازات."),
    ("", ""),
    ("h", "نظام الدوام:"),
    ("b", "• 6 أيام عمل متتالية ثم 4 أيام راحة (دورية) — دورة كل 10 أيام."),
    ("b", "• بداية الدوام اليومي: 2:00 عصراً."),
    ("b", "• الجدول يحسب الحالة (عمل/راحة) آلياً حسب «بداية الدورة» في ورقة الموظفين."),
    ("", ""),
    ("h", "أنواع الإجازات:"),
    ("b", "سنوية • عارض • دورية • مرضية • مرافق مريض • أخرى"),
    ("", ""),
    ("h", "كيف أحجز إجازة بدون تعارض؟"),
    ("b", "1) افتح ورقة «حجز الإجازات»."),
    ("b", "2) اختر اسم الموظف ونوع الإجازة من القائمة المنسدلة، وأدخل تاريخ البداية والنهاية."),
    ("b", "3) عمود «عدد الأيام» يُحسب تلقائياً، وعمود «فحص التعارض» يتحقق فوراً:"),
    ("b", "     ✓ سليم = لا يوجد تعارض   |   ⚠ تعارض = للموظف إجازة أخرى متداخلة بنفس الفترة."),
    ("b", "4) عمود «تنبيه التغطية» ينبّه إذا تجاوز عدد المُجازين في نفس اليوم الحد المسموح."),
    ("b", "5) غيّر «الحالة» إلى «معتمد» لتظهر الإجازة ملوّنة في جدول الورديات."),
    ("", ""),
    ("h", "ملاحظات:"),
    ("b", "• الصفوف الحمراء/التنبيهات تعني وجود تعارض — عالجه قبل الاعتماد."),
    ("b", "• في «جدول الورديات» يظهر أسفل كل يوم: عدد العاملين وعدد المُجازين؛ ويتلوّن بالأحمر عند نقص التغطية."),
    ("b", "• كل التواريخ بصيغة يوم/شهر/سنة. عدّل «بداية الفترة» وعدد الموظفين بحرية."),
]
r = 1
for kind, text in rows:
    c = ws_info.cell(row=r, column=2, value=text)
    if kind == "title":
        c.font = TITLE_FONT
        ws_info.row_dimensions[r].height = 26
    elif kind == "sub":
        c.font = SUB_FONT
    elif kind == "h":
        c.font = Font(name="Arial", bold=True, color="C00000", size=12)
    else:
        c.font = BASE_FONT
    c.alignment = RIGHT
    r += 1

# =================================================================  الإعدادات والقوائم
ws_set = wb.create_sheet("الإعدادات والقوائم")
ws_set.sheet_view.rightToLeft = True
ws_set.column_dimensions["A"].width = 30
ws_set.column_dimensions["B"].width = 18
ws_set.column_dimensions["D"].width = 18
ws_set.column_dimensions["F"].width = 18

ws_set["A1"] = "الإعدادات العامة"
ws_set["A1"].font = SUB_FONT
settings = [
    ("بداية فترة الجدول", PERIOD_START),
    ("طول دورة العمل (أيام)", 6),
    ("طول الراحة الدورية (أيام)", 4),
    ("الحد الأدنى للعاملين يومياً", 4),
    ("أقصى عدد مُجازين في اليوم", 3),
]
for i, (k, v) in enumerate(settings, start=2):
    a = ws_set.cell(row=i, column=1, value=k)
    a.font = Font(name="Arial", bold=True, size=11)
    a.alignment = RIGHT
    a.border = BORDER
    b = ws_set.cell(row=i, column=2, value=v)
    b.alignment = CENTER
    b.border = BORDER
    if isinstance(v, datetime.date):
        b.number_format = "DD/MM/YYYY"
# مراجع الإعدادات
CYCLE_WORK = "'الإعدادات والقوائم'!$B$3"
CYCLE_REST = "'الإعدادات والقوائم'!$B$4"
MIN_STAFF = "'الإعدادات والقوائم'!$B$5"
MAX_LEAVE = "'الإعدادات والقوائم'!$B$6"

# قوائم منسدلة
ws_set["D1"] = "أنواع الإجازات"
ws_set["D1"].font = SUB_FONT
for i, t in enumerate(LEAVE_TYPES, start=2):
    cc = ws_set.cell(row=i, column=4, value=t)
    cc.alignment = CENTER
    cc.border = BORDER
    cc.fill = PatternFill("solid", fgColor=COLORS[t])

ws_set["F1"] = "حالات الطلب"
ws_set["F1"].font = SUB_FONT
for i, s in enumerate(STATUSES, start=2):
    cc = ws_set.cell(row=i, column=6, value=s)
    cc.alignment = CENTER
    cc.border = BORDER

TYPES_RANGE = f"'الإعدادات والقوائم'!$D$2:$D${1+len(LEAVE_TYPES)}"
STATUS_RANGE = f"'الإعدادات والقوائم'!$F$2:$F${1+len(STATUSES)}"

# =================================================================  الموظفون
ws_emp = wb.create_sheet("الموظفون")
ws_emp.sheet_view.rightToLeft = True
emp_headers = ["م", "الاسم", "الرقم الوظيفي", "بداية الدورة"]
widths = [6, 32, 16, 16]
for col, (h, w) in enumerate(zip(emp_headers, widths), start=1):
    c = ws_emp.cell(row=1, column=col, value=h)
    style_header(c)
    ws_emp.column_dimensions[get_column_letter(col)].width = w
for i, (num, name, jobno) in enumerate(EMPLOYEES, start=2):
    ws_emp.cell(row=i, column=1, value=num).alignment = CENTER
    ws_emp.cell(row=i, column=2, value=name).alignment = RIGHT
    ws_emp.cell(row=i, column=3, value=jobno).alignment = CENTER
    d = ws_emp.cell(row=i, column=4, value=PERIOD_START)
    d.alignment = CENTER
    d.number_format = "DD/MM/YYYY"
    for col in range(1, 5):
        ws_emp.cell(row=i, column=col).border = BORDER
        ws_emp.cell(row=i, column=col).font = BASE_FONT
ws_emp.freeze_panes = "A2"
EMP_LAST = 1 + len(EMPLOYEES)
NAMES_RANGE = f"'الموظفون'!$B$2:$B${EMP_LAST}"

# =================================================================  حجز الإجازات
ws_lv = wb.create_sheet("حجز الإجازات")
ws_lv.sheet_view.rightToLeft = True
lv_headers = ["رقم الطلب", "اسم الموظف", "نوع الإجازة", "من تاريخ", "إلى تاريخ",
              "عدد الأيام", "الحالة", "فحص التعارض", "تنبيه التغطية", "ملاحظات"]
lv_widths = [10, 28, 14, 13, 13, 10, 14, 16, 18, 26]
for col, (h, w) in enumerate(zip(lv_headers, lv_widths), start=1):
    c = ws_lv.cell(row=4, column=col, value=h)
    style_header(c)
    ws_lv.column_dimensions[get_column_letter(col)].width = w

ws_lv["A1"] = "حجز الإجازات — قسم العمليات الجمركية"
ws_lv["A1"].font = TITLE_FONT
ws_lv["A2"] = "سجّل الطلب ثم تأكد من خانتي «فحص التعارض» و«تنبيه التغطية» قبل الاعتماد."
ws_lv["A2"].font = Font(name="Arial", italic=True, color="C00000", size=10)

# نطاقات مطلقة لصفوف الإجازات
B = lambda r: f"$B${r}"
EMPS = f"'حجز الإجازات'!$B${L_FIRST}:$B${L_LAST}"
TYPES_COL = f"'حجز الإجازات'!$C${L_FIRST}:$C${L_LAST}"
STARTS = f"'حجز الإجازات'!$D${L_FIRST}:$D${L_LAST}"
ENDS = f"'حجز الإجازات'!$E${L_FIRST}:$E${L_LAST}"
STAT = f"'حجز الإجازات'!$G${L_FIRST}:$G${L_LAST}"

for row in range(L_FIRST, L_LAST + 1):
    # رقم الطلب
    ws_lv.cell(row=row, column=1, value=row - L_FIRST + 1).alignment = CENTER
    # عدد الأيام = نهاية - بداية + 1
    ws_lv.cell(row=row, column=6,
               value=f'=IF(OR($D{row}="",$E{row}=""),"",$E{row}-$D{row}+1)').alignment = CENTER
    # فحص التعارض: تداخل مع طلب آخر لنفس الموظف غير مرفوض
    overlap = (f'SUMPRODUCT(({EMPS}=$B{row})*({STAT}<>"مرفوض")'
               f'*({STARTS}<=$E{row})*($D{row}<=({ENDS})))')
    self_q = f'(($B{row}<>"")*($G{row}<>"مرفوض"))'
    ws_lv.cell(row=row, column=8,
               value=f'=IF(OR($B{row}="",$D{row}="",$E{row}=""),"",'
                     f'IF({overlap}-{self_q}>0,"⚠ تعارض","✓ سليم"))').alignment = CENTER
    # تنبيه التغطية: عدد المُجازين (غير مرفوض) المتداخلين مع يوم البداية
    cover = (f'SUMPRODUCT(({STAT}<>"مرفوض")*({STARTS}<=$D{row})*($D{row}<=({ENDS})))')
    ws_lv.cell(row=row, column=9,
               value=f'=IF($D{row}="","",IF({cover}>{MAX_LEAVE},'
                     f'"⚠ تجاوز الحد ("&{cover}&")","✓ ضمن الحد"))').alignment = CENTER
    for col in range(1, 11):
        cell = ws_lv.cell(row=row, column=col)
        cell.border = BORDER
        cell.font = BASE_FONT
        if col in (4, 5):
            cell.number_format = "DD/MM/YYYY"
        if col in (2, 10):
            cell.alignment = RIGHT
        elif col not in (4, 5):
            cell.alignment = CENTER

# قوائم منسدلة
dv_name = DataValidation(type="list", formula1=f"={NAMES_RANGE}", allow_blank=True)
dv_type = DataValidation(type="list", formula1=f"={TYPES_RANGE}", allow_blank=True)
dv_stat = DataValidation(type="list", formula1=f"={STATUS_RANGE}", allow_blank=True)
ws_lv.add_data_validation(dv_name)
ws_lv.add_data_validation(dv_type)
ws_lv.add_data_validation(dv_stat)
dv_name.add(f"B{L_FIRST}:B{L_LAST}")
dv_type.add(f"C{L_FIRST}:C{L_LAST}")
dv_stat.add(f"G{L_FIRST}:G{L_LAST}")

# تنسيق شرطي لورقة الإجازات
ws_lv.conditional_formatting.add(
    f"H{L_FIRST}:H{L_LAST}",
    CellIsRule(operator="equal", formula=['"⚠ تعارض"'],
               fill=PatternFill("solid", fgColor="FFC7CE"),
               font=Font(color="9C0006", bold=True)))
ws_lv.conditional_formatting.add(
    f"H{L_FIRST}:H{L_LAST}",
    CellIsRule(operator="equal", formula=['"✓ سليم"'],
               fill=PatternFill("solid", fgColor="C6EFCE"),
               font=Font(color="006100")))
ws_lv.conditional_formatting.add(
    f"I{L_FIRST}:I{L_LAST}",
    FormulaRule(formula=[f'LEFT($I{L_FIRST})="⚠"'],
                fill=PatternFill("solid", fgColor="FFEB9C"),
                font=Font(color="9C6500", bold=True)))
# تلوين نوع الإجازة حسب اللون
for t in LEAVE_TYPES:
    ws_lv.conditional_formatting.add(
        f"C{L_FIRST}:C{L_LAST}",
        CellIsRule(operator="equal", formula=[f'"{t}"'],
                   fill=PatternFill("solid", fgColor=COLORS[t])))
ws_lv.freeze_panes = f"A{L_FIRST}"

# =================================================================  جدول الورديات
ws_r = wb.create_sheet("جدول الورديات")
ws_r.sheet_view.rightToLeft = True
ws_r["A1"] = "جدول الورديات — 6 عمل / 4 راحة — الدوام 2:00 عصراً"
ws_r["A1"].font = TITLE_FONT

# الأعمدة الثابتة
fixed = ["م", "الاسم", "الرقم الوظيفي"]
for col, h in enumerate(fixed, start=1):
    c = ws_r.cell(row=3, column=col, value=h)
    style_header(c)
ws_r.column_dimensions["A"].width = 5
ws_r.column_dimensions["B"].width = 26
ws_r.column_dimensions["C"].width = 13

DAY_COL0 = 4  # أول عمود تاريخ = D
dates = [PERIOD_START + datetime.timedelta(days=i) for i in range(DAYS)]
# صف اليوم (الاسم) في الصف 2، والتاريخ في الصف 3 يستخدم كعنوان؟ نضع التاريخ بصف 3 العلوي
# نستخدم: صف2 = اسم اليوم ، صف3 = التاريخ (وهو الذي تشير له الصيغ)
for i, d in enumerate(dates):
    col = DAY_COL0 + i
    letter = get_column_letter(col)
    ws_r.column_dimensions[letter].width = 6
    dn = ws_r.cell(row=2, column=col, value=AR_DAYS[d.weekday()])
    dn.fill = PatternFill("solid", fgColor="8EA9DB")
    dn.font = Font(name="Arial", bold=True, color="1F3864", size=8)
    dn.alignment = CENTER
    dn.border = BORDER
    dc = ws_r.cell(row=3, column=col, value=d)
    dc.number_format = "DD/MM"
    style_header(dc)
    if d.weekday() == 4:  # الجمعة
        dc.fill = PatternFill("solid", fgColor="C00000")

ws_r.cell(row=2, column=2, value="التاريخ ←").alignment = CENTER

EMP_ROW0 = 4
for idx, (num, name, jobno) in enumerate(EMPLOYEES):
    row = EMP_ROW0 + idx
    erow = 2 + idx  # صف الموظف في ورقة الموظفين
    ws_r.cell(row=row, column=1, value=num).alignment = CENTER
    ws_r.cell(row=row, column=2, value=f"='الموظفون'!B{erow}").alignment = RIGHT
    ws_r.cell(row=row, column=3, value=f"='الموظفون'!C{erow}").alignment = CENTER
    cs = f"'الموظفون'!$D${erow}"          # بداية الدورة لهذا الموظف
    nm = f"'الموظفون'!$B${erow}"          # اسم الموظف
    cyc = int(0)
    for i in range(DAYS):
        col = DAY_COL0 + i
        dref = f"{get_column_letter(col)}$3"
        # حالة الدورة: عمل/راحة
        cycle = (f'IF({dref}<{cs},"",IF(MOD({dref}-{cs},{CYCLE_WORK}+{CYCLE_REST})'
                 f'<{CYCLE_WORK},"عمل","راحة"))')
        # هل توجد إجازة معتمدة لهذا الموظف بهذا التاريخ؟
        match = (f'SUMPRODUCT(({EMPS}={nm})*({STARTS}<={dref})*'
                 f'(({ENDS})>={dref})*({STAT}="معتمد")*ROW({EMPS}))')
        idxf = f'({match})-{L_FIRST}+1'
        formula = (f'=IF({match}=0,{cycle},INDEX({TYPES_COL},{idxf}))')
        cc = ws_r.cell(row=row, column=col, value=formula)
        cc.alignment = CENTER
        cc.font = Font(name="Arial", size=8)
        cc.border = BORDER
    for col in (1, 2, 3):
        ws_r.cell(row=row, column=col).border = BORDER
        ws_r.cell(row=row, column=col).font = BASE_FONT

# صفوف الملخص أسفل الجدول
sum_row1 = EMP_ROW0 + len(EMPLOYEES)       # عدد العاملين
sum_row2 = sum_row1 + 1                     # عدد المُجازين
emp_first_letter = get_column_letter(DAY_COL0)
ws_r.cell(row=sum_row1, column=2, value="عدد العاملين (عمل)").alignment = RIGHT
ws_r.cell(row=sum_row2, column=2, value="عدد المُجازين").alignment = RIGHT
for cell in (ws_r.cell(row=sum_row1, column=2), ws_r.cell(row=sum_row2, column=2)):
    cell.font = Font(name="Arial", bold=True, size=10)
for i in range(DAYS):
    col = DAY_COL0 + i
    letter = get_column_letter(col)
    rng = f"{letter}{EMP_ROW0}:{letter}{EMP_ROW0+len(EMPLOYEES)-1}"
    c1 = ws_r.cell(row=sum_row1, column=col, value=f'=COUNTIF({rng},"عمل")')
    c1.alignment = CENTER
    c1.font = Font(name="Arial", bold=True, size=9)
    c1.border = BORDER
    # المُجازين = خلايا ليست عمل/راحة/فارغة
    c2 = ws_r.cell(row=sum_row2, column=col,
                   value=f'=SUMPRODUCT(({rng}<>"")*({rng}<>"عمل")*({rng}<>"راحة"))')
    c2.alignment = CENTER
    c2.font = Font(name="Arial", bold=True, size=9)
    c2.border = BORDER
    # تلوين نقص التغطية
    ws_r.conditional_formatting.add(
        c1.coordinate,
        CellIsRule(operator="lessThan", formula=[MIN_STAFF],
                   fill=PatternFill("solid", fgColor="FFC7CE"),
                   font=Font(color="9C0006", bold=True)))

# تنسيق شرطي لخلايا الجدول (ألوان الحالات)
grid_range = (f"{emp_first_letter}{EMP_ROW0}:"
              f"{get_column_letter(DAY_COL0+DAYS-1)}{EMP_ROW0+len(EMPLOYEES)-1}")
for key, color in COLORS.items():
    ws_r.conditional_formatting.add(
        grid_range,
        CellIsRule(operator="equal", formula=[f'"{key}"'],
                   fill=PatternFill("solid", fgColor=color)))

ws_r.freeze_panes = "D4"

# مفتاح الألوان (Legend)
leg_row = sum_row2 + 2
ws_r.cell(row=leg_row, column=2, value="مفتاح الألوان:").font = Font(bold=True, size=10)
legend_items = ["عمل", "راحة"] + LEAVE_TYPES
for i, k in enumerate(legend_items):
    cell = ws_r.cell(row=leg_row + 1 + i, column=2, value=k)
    cell.fill = PatternFill("solid", fgColor=COLORS[k])
    cell.alignment = RIGHT
    cell.border = BORDER
    cell.font = BASE_FONT

# ------------------------------------------------------------------ حفظ
# إجبار البرنامج على إعادة احتساب جميع الصيغ عند فتح الملف
try:
    wb.calculation.fullCalcOnLoad = True
except Exception:
    pass
out = "/home/user/ghost/جدول_الورديات_وحجز_الإجازات.xlsx"
wb.save(out)
print("تم الحفظ:", out)
