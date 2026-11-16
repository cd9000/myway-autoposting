import math

W, H = 1180, 800
F = "DejaVu Sans, Arial, sans-serif"
out = []
a = out.append
a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{F}">')
a('<defs><marker id="open" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" orient="auto">'
  '<path d="M0,0 L10,5 L0,10" fill="none" stroke="#374151" stroke-width="1.5"/></marker></defs>')
a(f'<rect width="{W}" height="{H}" fill="white"/>')
a(f'<text x="{W/2}" y="34" text-anchor="middle" font-size="20" fill="#111827">Диаграмма вариантов использования · MyWay</text>')

# system boundary
BX, BY, BW, BH = 270, 60, 660, 715
a(f'<rect x="{BX}" y="{BY}" width="{BW}" height="{BH}" rx="6" fill="#F9FAFB" stroke="#6B7280" stroke-width="1.5"/>')
a(f'<text x="{BX+14}" y="{BY+24}" font-size="14" fill="#374151">Система «MyWay автопостинг» (n8n + PostgreSQL)</text>')

A_X, B_X = 470, 800
UC = {
    "UC-01": (A_X, 115, 165, "UC-01 Подготовить черновик"),
    "UC-02": (A_X, 185, 165, "UC-02 Принять и запланировать"),
    "UC-03": (B_X, 185, 120, "UC-03 Создать иллюстрацию"),
    "UC-04": (A_X, 265, 165, "UC-04 Получить превью поста"),
    "UC-05": (A_X, 330, 165, "UC-05 Отменить пост"),
    "UC-06": (A_X, 395, 165, "UC-06 Запланировать вручную"),
    "UC-07": (A_X, 460, 165, "UC-07 Посмотреть очередь"),
    "UC-11": (A_X, 525, 165, "UC-11 Переключить test / live"),
    "UC-10": (A_X, 590, 165, "UC-10 Получить утреннюю сводку"),
    "UC-08": (A_X, 670, 165, "UC-08 Опубликовать по расписанию"),
    "UC-09": (B_X, 735, 110, "UC-09 Сообщить о сбое"),
}
RY = 27

def edge_pt(uc, px, py):
    cx, cy, rx, _ = UC[uc]
    dx, dy = px - cx, py - cy
    t = 1 / math.sqrt((dx / rx) ** 2 + (dy / RY) ** 2)
    return cx + dx * t, cy + dy * t

lines = []
def assoc(ax, ay, uc):
    cx, cy, rx, _ = UC[uc]
    x, y = (cx - rx, cy) if ax < cx else (cx + rx, cy)
    lines.append(f'<line x1="{ax}" y1="{ay}" x2="{x:.1f}" y2="{y:.1f}" stroke="#374151" stroke-width="1.3"/>')

def dep(src, dst, label):
    sx, sy, _, _ = UC[src]
    dx, dy, _, _ = UC[dst]
    x1, y1 = edge_pt(src, dx, dy)
    x2, y2 = edge_pt(dst, sx, sy)
    lines.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#374151" stroke-width="1.3" stroke-dasharray="6,4" marker-end="url(#open)"/>')
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    lines.append(f'<text x="{mx:.1f}" y="{my-12:.1f}" font-size="12" fill="#4B5563" text-anchor="middle">«{label}»</text>')

def stick(x, y, label, sub=None):
    s = [f'<circle cx="{x}" cy="{y-38}" r="11" fill="white" stroke="#111827" stroke-width="1.6"/>',
         f'<line x1="{x}" y1="{y-27}" x2="{x}" y2="{y+5}" stroke="#111827" stroke-width="1.6"/>',
         f'<line x1="{x-18}" y1="{y-16}" x2="{x+18}" y2="{y-16}" stroke="#111827" stroke-width="1.6"/>',
         f'<line x1="{x}" y1="{y+5}" x2="{x-14}" y2="{y+28}" stroke="#111827" stroke-width="1.6"/>',
         f'<line x1="{x}" y1="{y+5}" x2="{x+14}" y2="{y+28}" stroke="#111827" stroke-width="1.6"/>',
         f'<text x="{x}" y="{y+48}" font-size="14" text-anchor="middle" fill="#111827">{label}</text>']
    if sub:
        s.append(f'<text x="{x}" y="{y+65}" font-size="11" text-anchor="middle" fill="#6B7280">{sub}</text>')
    return s

def sysactor(x, y, label):
    return [f'<rect x="{x-62}" y="{y-26}" width="124" height="52" rx="4" fill="white" stroke="#111827" stroke-width="1.4"/>',
            f'<text x="{x}" y="{y-6}" font-size="11" text-anchor="middle" fill="#6B7280">«system»</text>',
            f'<text x="{x}" y="{y+13}" font-size="14" text-anchor="middle" fill="#111827">{label}</text>']

# actors (anchor = shoulder point used for lines)
AI = (120, 165); AUTH = (120, 430); TIMER = (120, 650)
TG = (1075, 430); SUB = (1075, 640)
actors = []
actors += stick(*AI, "ИИ-автор", "задача Claude")
actors += stick(*AUTH, "Автор канала")
actors += sysactor(TIMER[0], TIMER[1], "Таймер")
actors += sysactor(TG[0], TG[1], "Telegram")
actors += stick(*SUB, "Подписчик", "Telegram, Дзен")

ai_pt = (AI[0] + 22, AI[1] - 16)
au_pt = (AUTH[0] + 22, AUTH[1] - 16)
tm_pt = (TIMER[0] + 62, TIMER[1])
tg_pt = (TG[0] - 62, TG[1])
sb_pt = (SUB[0] - 22, SUB[1] - 16)

for u in ["UC-01", "UC-02"]: assoc(*ai_pt, u)
for u in ["UC-04", "UC-05", "UC-06", "UC-07", "UC-10", "UC-11"]: assoc(*au_pt, u)
for u in ["UC-08", "UC-10"]: assoc(*tm_pt, u)
assoc(*tg_pt, "UC-04"); assoc(*tg_pt, "UC-08")
assoc(*sb_pt, "UC-08")
dep("UC-02", "UC-03", "include")
dep("UC-09", "UC-08", "extend")

a("\n".join(lines))
for k, (cx, cy, rx, text) in UC.items():
    a(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{RY}" fill="#EEF2FF" stroke="#4F46E5" stroke-width="1.5"/>')
    a(f'<text x="{cx}" y="{cy+5}" font-size="13" text-anchor="middle" fill="#111827">{text}</text>')
a("\n".join(actors))
a('</svg>')
open("usecase.svg", "w", encoding="utf-8").write("\n".join(out))
