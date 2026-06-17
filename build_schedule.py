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

# بيانات الإجازات المسجّلة مسبقاً (مأخوذة من ورقة المستخدم) — (الاسم، النوع، من، إلى، الحالة)
import datetime as _dt
LEAVE_DATA = [
    ("سالم شليويح المري", "دورية", _dt.date(2026, 6, 17), _dt.date(2026, 6, 19), "معتمد"),
    ("فهد عبدالعزيز عبدالله", "سنوية", _dt.date(2026, 6, 18), _dt.date(2026, 6, 19), "معتمد"),
    ("محمد ناصر الغانم", "دورية", _dt.date(2026, 6, 28), _dt.date(2026, 7, 2), "معتمد"),
    ("محمد ناصر الغانم", "دورية", _dt.date(2026, 7, 5), _dt.date(2026, 7, 9), "معتمد"),
    ("منصور مبارك الجابري", "سنوية", _dt.date(2026, 7, 4), _dt.date(2026, 7, 9), "معتمد"),
    ("منصور مبارك الجابري", "سنوية", _dt.date(2026, 6, 18), _dt.date(2026, 6, 19), "معتمد"),
    ("محمد حمد الجابر", "سنوية", _dt.date(2026, 6, 17), _dt.date(2026, 6, 19), "معتمد"),
    ("عبدالله سعد المهندي", "مرافق مريض", _dt.date(2026, 6, 17), _dt.date(2026, 7, 30), "معتمد"),
    ("راشد عيسى التميمي", "سنوية", _dt.date(2026, 7, 4), _dt.date(2026, 7, 9), "معتمد"),
    ("راشد عيسى التميمي", "عارض", _dt.date(2026, 7, 14), _dt.date(2026, 7, 14), "معتمد"),
    ("راشد عيسى التميمي", "سنوية", _dt.date(2026, 7, 15), _dt.date(2026, 7, 19), "معتمد"),
    ("راشد عيسى التميمي", "أخرى", _dt.date(2026, 6, 17), _dt.date(2026, 6, 17), "معتمد"),
]

# الورديات (الزامات) وأوقاتها
SHIFTS = [
    ("صباح", "6:00 ص ← 1:00 م"),
    ("عصر", "1:00 م ← 9:00 م"),
    ("ليل", "9:00 م ← 6:00 ص (اليوم التالي)"),
]
SHIFT_NAMES = [s[0] for s in SHIFTS]
DEFAULT_SHIFT = "عصر"

# لون لكل وردية / حالة / نوع إجازة
COLORS = {
    "صباح":       "FFF2CC",   # أصفر باهت
    "عصر":        "C6EFCE",   # أخضر فاتح
    "ليل":        "8EAADB",   # أزرق
    "راحة":       "D9D9D9",   # رمادي
    "سنوية":      "FFE699",   # كهرماني
    "عارض":       "F8CBAD",   # برتقالي
    "دورية":      "BDD7EE",   # أزرق فاتح
    "مرضية":      "FFC7CE",   # أحمر فاتح
    "مرافق مريض": "E2A9F3",   # بنفسجي
    "أخرى":       "FCE4D6",   # خوخي
}

PERIOD_START = datetime.date(2026, 6, 16)   # أول يوم في الجدول
DAYS = 365                                  # سنة كاملة
AR_DAYS = ["الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]
AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
             "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]

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


def cf_fill(color):
    """تعبئة للتنسيق الشرطي: إكسل يقرأ لون التعبئة من bgColor وليس fgColor."""
    return PatternFill(start_color=color, end_color=color, fill_type="solid")


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
    ("b", "3) تقويم الإجازات: عرض واضح للإجازات المعتمدة فقط (موظفون × أيام) مع إجمالي أيام كل موظف."),
    ("b", "4) حجز الإجازات: تُسجَّل فيه طلبات الإجازة، ويكشف التعارض تلقائياً."),
    ("b", "5) الإعدادات والقوائم: ضبط بداية الدورة والحد الأدنى للتغطية وأنواع الإجازات."),
    ("", ""),
    ("h", "نظام الدوام:"),
    ("b", "• 6 أيام عمل متتالية ثم 4 أيام راحة (دورية) — دورة كل 10 أيام."),
    ("b", "• ثلاث ورديات (زامات):"),
    ("b", "     صباح: 6:00 ص ← 1:00 م   |   عصر: 1:00 م ← 9:00 م   |   ليل: 9:00 م ← 6:00 ص (اليوم التالي)."),
    ("b", "• وردية كل موظف تُحدَّد من عمود «الوردية» في ورقة الموظفين (قابلة للتغيير)."),
    ("b", "• الجدول يعرض اسم وردية الموظف على أيام عمله و«راحة» على أيام راحته — تلقائياً."),
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
# مراجع الإعدادات — أسماء معرّفة لضمان التحديث في الصيغ والتنسيق الشرطي عبر الأوراق
from openpyxl.workbook.defined_name import DefinedName
wb.defined_names["CycleWork"] = DefinedName("CycleWork", attr_text="'الإعدادات والقوائم'!$B$3")
wb.defined_names["CycleRest"] = DefinedName("CycleRest", attr_text="'الإعدادات والقوائم'!$B$4")
wb.defined_names["MinStaff"] = DefinedName("MinStaff", attr_text="'الإعدادات والقوائم'!$B$5")
wb.defined_names["MaxLeave"] = DefinedName("MaxLeave", attr_text="'الإعدادات والقوائم'!$B$6")
CYCLE_WORK = "CycleWork"
CYCLE_REST = "CycleRest"
MIN_STAFF = "MinStaff"
MAX_LEAVE = "MaxLeave"

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

# جدول الورديات (الزامات) وأوقاتها
ws_set["H1"] = "الوردية"
ws_set["I1"] = "التوقيت"
ws_set.column_dimensions["H"].width = 12
ws_set.column_dimensions["I"].width = 30
for cc in (ws_set["H1"], ws_set["I1"]):
    style_header(cc)
for i, (nm, tm) in enumerate(SHIFTS, start=2):
    h = ws_set.cell(row=i, column=8, value=nm)
    h.alignment = CENTER
    h.border = BORDER
    h.fill = PatternFill("solid", fgColor=COLORS[nm])
    t = ws_set.cell(row=i, column=9, value=tm)
    t.alignment = RIGHT
    t.border = BORDER
SHIFTS_RANGE = f"'الإعدادات والقوائم'!$H$2:$H${1+len(SHIFTS)}"

# =================================================================  الموظفون
ws_emp = wb.create_sheet("الموظفون")
ws_emp.sheet_view.rightToLeft = True
emp_headers = ["م", "الاسم", "الرقم الوظيفي", "الوردية", "بداية الدورة"]
widths = [6, 32, 16, 14, 16]
for col, (h, w) in enumerate(zip(emp_headers, widths), start=1):
    c = ws_emp.cell(row=1, column=col, value=h)
    style_header(c)
    ws_emp.column_dimensions[get_column_letter(col)].width = w
for i, (num, name, jobno) in enumerate(EMPLOYEES, start=2):
    ws_emp.cell(row=i, column=1, value=num).alignment = CENTER
    ws_emp.cell(row=i, column=2, value=name).alignment = RIGHT
    ws_emp.cell(row=i, column=3, value=jobno).alignment = CENTER
    sh = ws_emp.cell(row=i, column=4, value=DEFAULT_SHIFT)
    sh.alignment = CENTER
    d = ws_emp.cell(row=i, column=5, value=PERIOD_START)
    d.alignment = CENTER
    d.number_format = "DD/MM/YYYY"
    for col in range(1, 6):
        ws_emp.cell(row=i, column=col).border = BORDER
        ws_emp.cell(row=i, column=col).font = BASE_FONT
ws_emp.freeze_panes = "A2"
EMP_LAST = 1 + len(EMPLOYEES)
NAMES_RANGE = f"'الموظفون'!$B$2:$B${EMP_LAST}"

# قائمة منسدلة لاختيار الوردية + تلوينها
dv_shift = DataValidation(type="list", formula1=f"={SHIFTS_RANGE}", allow_blank=True)
ws_emp.add_data_validation(dv_shift)
dv_shift.add(f"D2:D{EMP_LAST}")
for nm in SHIFT_NAMES:
    ws_emp.conditional_formatting.add(
        f"D2:D{EMP_LAST}",
        CellIsRule(operator="equal", formula=[f'"{nm}"'],
                   fill=cf_fill(COLORS[nm])))

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
                     f'"⚠ مجازين "&{cover}&" / الحد "&{MAX_LEAVE},'
                     f'"✓ مجازين "&{cover}&" / الحد "&{MAX_LEAVE}))').alignment = CENTER
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

# تعبئة بيانات الإجازات المسجّلة مسبقاً
for i, (name, typ, s, e, st) in enumerate(LEAVE_DATA):
    row = L_FIRST + i
    ws_lv.cell(row=row, column=2, value=name)
    ws_lv.cell(row=row, column=3, value=typ)
    ws_lv.cell(row=row, column=4, value=s).number_format = "DD/MM/YYYY"
    ws_lv.cell(row=row, column=5, value=e).number_format = "DD/MM/YYYY"
    ws_lv.cell(row=row, column=7, value=st)

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
               fill=cf_fill("FFC7CE"),
               font=Font(color="9C0006", bold=True)))
ws_lv.conditional_formatting.add(
    f"H{L_FIRST}:H{L_LAST}",
    CellIsRule(operator="equal", formula=['"✓ سليم"'],
               fill=cf_fill("C6EFCE"),
               font=Font(color="006100")))
ws_lv.conditional_formatting.add(
    f"I{L_FIRST}:I{L_LAST}",
    FormulaRule(formula=[f'LEFT($I{L_FIRST})="⚠"'],
                fill=cf_fill("FFEB9C"),
                font=Font(color="9C6500", bold=True)))
# تلوين نوع الإجازة حسب اللون
for t in LEAVE_TYPES:
    ws_lv.conditional_formatting.add(
        f"C{L_FIRST}:C{L_LAST}",
        CellIsRule(operator="equal", formula=[f'"{t}"'],
                   fill=cf_fill(COLORS[t])))
ws_lv.freeze_panes = f"A{L_FIRST}"

# =================================================================  جدول الورديات
ws_r = wb.create_sheet("جدول الورديات")
ws_r.sheet_view.rightToLeft = True
ws_r["A1"] = "جدول الورديات — 6 عمل / 4 راحة — صباح (6ص-1م) / عصر (1م-9م) / ليل (9م-6ص)"
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
    if d.day == 1 or i == 0:
        ml = ws_r.cell(row=1, column=col, value=f"{AR_MONTHS[d.month-1]} {d.year}")
        ml.font = Font(name="Arial", bold=True, color="1F3864", size=10)
        ml.alignment = Alignment(horizontal="right", vertical="center")

ws_r.cell(row=2, column=2, value="التاريخ ←").alignment = CENTER

EMP_ROW0 = 4
for idx, (num, name, jobno) in enumerate(EMPLOYEES):
    row = EMP_ROW0 + idx
    erow = 2 + idx  # صف الموظف في ورقة الموظفين
    ws_r.cell(row=row, column=1, value=num).alignment = CENTER
    ws_r.cell(row=row, column=2, value=f"='الموظفون'!B{erow}").alignment = RIGHT
    ws_r.cell(row=row, column=3, value=f"='الموظفون'!C{erow}").alignment = CENTER
    cs = f"'الموظفون'!$E${erow}"          # بداية الدورة لهذا الموظف
    nm = f"'الموظفون'!$B${erow}"          # اسم الموظف
    shift = f"'الموظفون'!$D${erow}"       # وردية هذا الموظف
    for i in range(DAYS):
        col = DAY_COL0 + i
        dref = f"{get_column_letter(col)}$3"
        # حالة الدورة: اسم الوردية في أيام العمل / راحة في أيام الراحة
        cycle = (f'IF({dref}<{cs},"",IF(MOD({dref}-{cs},{CYCLE_WORK}+{CYCLE_REST})'
                 f'<{CYCLE_WORK},{shift},"راحة"))')
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

# صفوف الملخص أسفل الجدول (عدّاد لكل وردية + الإجمالي + المُجازين)
emp_first_letter = get_column_letter(DAY_COL0)
emp_last_row = EMP_ROW0 + len(EMPLOYEES) - 1
summary_labels = SHIFT_NAMES + ["إجمالي العاملين", "عدد المُجازين"]
summary_rows = {}
for k, lbl in enumerate(summary_labels):
    rr = emp_last_row + 1 + k
    summary_rows[lbl] = rr
    lc = ws_r.cell(row=rr, column=2, value=lbl)
    lc.alignment = RIGHT
    lc.font = Font(name="Arial", bold=True, size=10)
    lc.border = BORDER
    if lbl in COLORS:
        lc.fill = PatternFill("solid", fgColor=COLORS[lbl])

total_row = summary_rows["إجمالي العاملين"]
for i in range(DAYS):
    col = DAY_COL0 + i
    letter = get_column_letter(col)
    rng = f"{letter}{EMP_ROW0}:{letter}{emp_last_row}"
    # عدّاد كل وردية
    for nm in SHIFT_NAMES:
        rr = summary_rows[nm]
        cc = ws_r.cell(row=rr, column=col, value=f'=COUNTIF({rng},"{nm}")')
        cc.alignment = CENTER
        cc.font = Font(name="Arial", bold=True, size=9)
        cc.border = BORDER
    # إجمالي العاملين = مجموع الورديات الثلاث
    parts = "+".join(f'COUNTIF({rng},"{nm}")' for nm in SHIFT_NAMES)
    ct = ws_r.cell(row=total_row, column=col, value=f"={parts}")
    ct.alignment = CENTER
    ct.font = Font(name="Arial", bold=True, size=9)
    ct.border = BORDER
    ws_r.conditional_formatting.add(
        ct.coordinate,
        CellIsRule(operator="lessThan", formula=[MIN_STAFF],
                   fill=cf_fill("FFC7CE"),
                   font=Font(color="9C0006", bold=True)))
    # المُجازين = خلايا ليست وردية/راحة/فارغة
    excl = "".join(f'*({rng}<>"{nm}")' for nm in SHIFT_NAMES)
    cl = ws_r.cell(row=summary_rows["عدد المُجازين"], column=col,
                   value=f'=SUMPRODUCT(({rng}<>""){excl}*({rng}<>"راحة"))')
    cl.alignment = CENTER
    cl.font = Font(name="Arial", bold=True, size=9)
    cl.border = BORDER

sum_row2 = summary_rows["عدد المُجازين"]

# تنسيق شرطي لخلايا الجدول (ألوان الحالات)
grid_range = (f"{emp_first_letter}{EMP_ROW0}:"
              f"{get_column_letter(DAY_COL0+DAYS-1)}{EMP_ROW0+len(EMPLOYEES)-1}")
for key, color in COLORS.items():
    ws_r.conditional_formatting.add(
        grid_range,
        CellIsRule(operator="equal", formula=[f'"{key}"'],
                   fill=cf_fill(color)))

ws_r.freeze_panes = "D4"

# مفتاح الألوان (Legend)
leg_row = sum_row2 + 2
ws_r.cell(row=leg_row, column=2, value="مفتاح الألوان:").font = Font(bold=True, size=10)
legend_items = SHIFT_NAMES + ["راحة"] + LEAVE_TYPES
for i, k in enumerate(legend_items):
    cell = ws_r.cell(row=leg_row + 1 + i, column=2, value=k)
    cell.fill = PatternFill("solid", fgColor=COLORS[k])
    cell.alignment = RIGHT
    cell.border = BORDER
    cell.font = BASE_FONT

# =================================================================  تقويم الإجازات (عرض واضح للإجازات فقط)
ws_lc = wb.create_sheet("تقويم الإجازات")
ws_lc.sheet_view.rightToLeft = True
ws_lc["A1"] = "تقويم الإجازات — يعرض الإجازات المعتمدة فقط بألوانها"
ws_lc["A1"].font = TITLE_FONT
ws_lc["A2"] = "كل خلية ملوّنة = إجازة معتمدة لذلك اليوم. الخلايا الفارغة = لا توجد إجازة."
ws_lc["A2"].font = Font(name="Arial", italic=True, color="44546A", size=10)

for col, h in enumerate(["م", "الاسم", "الرقم الوظيفي"], start=1):
    style_header(ws_lc.cell(row=3, column=col, value=h))
ws_lc.column_dimensions["A"].width = 5
ws_lc.column_dimensions["B"].width = 26
ws_lc.column_dimensions["C"].width = 13

for i, d in enumerate(dates):
    col = DAY_COL0 + i
    letter = get_column_letter(col)
    ws_lc.column_dimensions[letter].width = 6
    dn = ws_lc.cell(row=2, column=col, value=AR_DAYS[d.weekday()])
    dn.fill = PatternFill("solid", fgColor="8EA9DB")
    dn.font = Font(name="Arial", bold=True, color="1F3864", size=8)
    dn.alignment = CENTER
    dn.border = BORDER
    dc = ws_lc.cell(row=3, column=col, value=d)
    dc.number_format = "DD/MM"
    style_header(dc)
    if d.weekday() == 4:
        dc.fill = PatternFill("solid", fgColor="C00000")
    if d.day == 1 or i == 0:
        ml = ws_lc.cell(row=1, column=col, value=f"{AR_MONTHS[d.month-1]} {d.year}")
        ml.font = Font(name="Arial", bold=True, color="1F3864", size=10)
        ml.alignment = Alignment(horizontal="right", vertical="center")

TOTAL_COL = DAY_COL0 + DAYS            # عمود إجمالي أيام الإجازة لكل موظف
tcl = ws_lc.cell(row=3, column=TOTAL_COL, value="إجمالي الأيام")
style_header(tcl)
ws_lc.column_dimensions[get_column_letter(TOTAL_COL)].width = 11

for idx, (num, name, jobno) in enumerate(EMPLOYEES):
    row = EMP_ROW0 + idx
    erow = 2 + idx
    ws_lc.cell(row=row, column=1, value=num).alignment = CENTER
    ws_lc.cell(row=row, column=2, value=f"='الموظفون'!B{erow}").alignment = RIGHT
    ws_lc.cell(row=row, column=3, value=f"='الموظفون'!C{erow}").alignment = CENTER
    nm = f"'الموظفون'!$B${erow}"
    for i in range(DAYS):
        col = DAY_COL0 + i
        dref = f"{get_column_letter(col)}$3"
        match = (f'SUMPRODUCT(({EMPS}={nm})*({STARTS}<={dref})*'
                 f'(({ENDS})>={dref})*({STAT}="معتمد")*ROW({EMPS}))')
        idxf = f'({match})-{L_FIRST}+1'
        cc = ws_lc.cell(row=row, column=col,
                        value=f'=IF({match}=0,"",INDEX({TYPES_COL},{idxf}))')
        cc.alignment = CENTER
        cc.font = Font(name="Arial", size=8)
        cc.border = BORDER
    # إجمالي أيام الإجازة لهذا الموظف خلال الفترة
    rrow = (f"{get_column_letter(DAY_COL0)}{row}:"
            f"{get_column_letter(DAY_COL0+DAYS-1)}{row}")
    tc = ws_lc.cell(row=row, column=TOTAL_COL, value=f'=SUMPRODUCT(--({rrow}<>""))')
    tc.alignment = CENTER
    tc.font = Font(name="Arial", bold=True, size=10)
    tc.border = BORDER
    for col in (1, 2, 3):
        ws_lc.cell(row=row, column=col).border = BORDER
        ws_lc.cell(row=row, column=col).font = BASE_FONT

# صف إجمالي المُجازين لكل يوم
lc_total_row = EMP_ROW0 + len(EMPLOYEES)
tl = ws_lc.cell(row=lc_total_row, column=2, value="عدد المُجازين")
tl.alignment = RIGHT
tl.font = Font(name="Arial", bold=True, size=10)
tl.border = BORDER
for i in range(DAYS):
    col = DAY_COL0 + i
    letter = get_column_letter(col)
    colrng = f"{letter}{EMP_ROW0}:{letter}{EMP_ROW0+len(EMPLOYEES)-1}"
    tc = ws_lc.cell(row=lc_total_row, column=col, value=f'=SUMPRODUCT(--({colrng}<>""))')
    tc.alignment = CENTER
    tc.font = Font(name="Arial", bold=True, size=9)
    tc.border = BORDER
    # تلوين الأيام التي يتجاوز فيها عدد المُجازين الحد المسموح
    ws_lc.conditional_formatting.add(
        tc.coordinate,
        CellIsRule(operator="greaterThan", formula=[MAX_LEAVE],
                   fill=cf_fill("FFC7CE"),
                   font=Font(color="9C0006", bold=True)))

# تلوين خلايا الإجازات حسب النوع
lc_grid = (f"{get_column_letter(DAY_COL0)}{EMP_ROW0}:"
           f"{get_column_letter(DAY_COL0+DAYS-1)}{EMP_ROW0+len(EMPLOYEES)-1}")
for t in LEAVE_TYPES:
    ws_lc.conditional_formatting.add(
        lc_grid,
        CellIsRule(operator="equal", formula=[f'"{t}"'],
                   fill=cf_fill(COLORS[t])))
ws_lc.freeze_panes = "D4"

# مفتاح ألوان أنواع الإجازات
lc_leg = lc_total_row + 2
ws_lc.cell(row=lc_leg, column=2, value="مفتاح ألوان الإجازات:").font = Font(bold=True, size=10)
for i, t in enumerate(LEAVE_TYPES):
    cell = ws_lc.cell(row=lc_leg + 1 + i, column=2, value=t)
    cell.fill = PatternFill("solid", fgColor=COLORS[t])
    cell.alignment = RIGHT
    cell.border = BORDER
    cell.font = BASE_FONT

# ------------------------------------------------------------------ حفظ
# إجبار البرنامج على إعادة احتساب جميع الصيغ عند فتح الملف
try:
    wb.calculation.fullCalcOnLoad = True
    wb.calculation.calcMode = "auto"
except Exception:
    pass
out = "/home/user/ghost/جدول_الورديات_وحجز_الإجازات.xlsx"
wb.save(out)
print("تم الحفظ:", out)
