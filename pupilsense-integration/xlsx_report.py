"""
xlsx_report.py - builds the end-of-session Excel summary for Catch Your Bus + PupilSense.
Called by pupil_server.py (POST /export). Requires: pip install openpyxl
"""
from datetime import datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.chart import LineChart, BarChart, Reference
from openpyxl.utils import get_column_letter
from openpyxl.comments import Comment

FONT = "Arial"
F = Font(name=FONT, size=10)
FB = Font(name=FONT, size=10, bold=True)
FH = Font(name=FONT, size=10, bold=True, color="FFFFFF")
FT = Font(name=FONT, size=16, bold=True, color="1D6041")
FS = Font(name=FONT, size=11, bold=True, color="1D6041")
FN = Font(name=FONT, size=9, italic=True, color="78847B")
HEAD = PatternFill("solid", start_color="267B53")
BAND = PatternFill("solid", start_color="EAF3ED")
THIN = Border(bottom=Side(style="thin", color="DDE2DB"))


def _num(v):
    try:
        if v is None or v == "" or v == "–":
            return None
        f = float(v)
        return f if f == f else None   # drop NaN
    except (TypeError, ValueError):
        return None


def _header(ws, row, labels, col=1):
    for i, h in enumerate(labels):
        c = ws.cell(row=row, column=col + i, value=h)
        c.font, c.fill = FH, HEAD
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 30


def _widths(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _fontall(ws):
    for row in ws.iter_rows():
        for c in row:
            if c.font is None or c.font.name != FONT:
                c.font = Font(name=FONT, size=c.font.size if c.font else 10, bold=c.font.bold if c.font else False,
                              italic=c.font.italic if c.font else False, color=c.font.color if c.font else None)


SCREEN_OF = {"memory": "Remember", "search": "Find", "confirm": "Find", "baseline": "Baseline"}


def _pupil_sheet(wb, trials, samples, meta):
    """'Pupil diameter' sheet: baselines, per-game stats (formulas over 'Pupil samples'), charts."""
    wp = wb.create_sheet("Pupil diameter", 1)
    ns = max(len(samples) + 1, 2)
    S = lambda col: f"'Pupil samples'!${col}$2:${col}${ns}"
    P, L, Rr, BL, V, SET, GAME, SCR = S("E"), S("F"), S("G"), S("H"), S("I"), S("C"), S("D"), S("O")
    wp["A1"] = "Pupil diameter"; wp["A1"].font = FT
    wp["A2"] = ("Values are means of valid webcam readings (blinks, no face and post-stand-up frames excluded), in mm, "
                "computed with formulas from the 'Pupil samples' sheet.")
    wp["A2"].font = FN

    wp["A4"] = "Baseline (relaxed, looking at the cross)"; wp["A4"].font = FS
    _header(wp, 5, ["Screen", "Baseline (mm)", "SD (mm)", "Usable readings"])
    for i, (lab, k) in enumerate((("Remember", "Memory"), ("Find", "Search"))):
        r = 6 + i
        vals = [lab, _num(meta.get(f"base{k}")), _num(meta.get(f"base{k}SD")), _num(meta.get(f"base{k}Valid"))]
        for j, v in enumerate(vals, 1):
            c = wp.cell(row=r, column=j, value=v); c.font = F; c.border = THIN
        wp.cell(row=r, column=2).number_format = "0.00"; wp.cell(row=r, column=3).number_format = "0.00"
        wp.cell(row=r, column=4).number_format = "0%"
    wp["E6"] = "Recorded by the overlay during calibration (median of valid readings)."; wp["E6"].font = FN

    wp["A10"] = "Per game"; wp["A10"].font = FS
    cols = ["Trial", "Set", "Game", "Level", "Remember mean (mm)", "Remember Δ (mm)", "Find mean (mm)", "Find Δ (mm)",
            "Find change (%)", "Find min (mm)", "Find max (mm)", "Find left eye (mm)", "Find right eye (mm)",
            "Valid Find readings", "Blinks (Find)", "Workload level", "Remember baseline", "Find baseline"]
    _header(wp, 11, cols)
    has_base = _num(meta.get("baseMemory")) is not None and _num(meta.get("baseSearch")) is not None
    for i, t in enumerate(trials):
        r = 12 + i
        tr = i + 2  # matching row on Trials
        crit = lambda scr: f'{SET},$B{r},{GAME},$C{r},{SCR},"{scr}"'
        cells = [
            f"=Trials!A{tr}", f"=Trials!B{tr}", f"=Trials!C{tr}", f"=Trials!D{tr}",
            f'=IFERROR(AVERAGEIFS({P},{crit("Remember")},{V},TRUE),"")',
            f'=IF(AND(ISNUMBER(E{r}),ISNUMBER(Q{r})),E{r}-Q{r},"")',
            f'=IFERROR(AVERAGEIFS({P},{crit("Find")},{V},TRUE),"")',
            f'=IF(AND(ISNUMBER(G{r}),ISNUMBER(R{r})),G{r}-R{r},"")',
            f'=IF(AND(ISNUMBER(H{r}),ISNUMBER(R{r}),R{r}<>0),H{r}/R{r},"")',
            f'=IF(N{r}>0,_xlfn.MINIFS({P},{crit("Find")},{V},TRUE),"")',
            f'=IF(N{r}>0,_xlfn.MAXIFS({P},{crit("Find")},{V},TRUE),"")',
            f'=IFERROR(AVERAGEIFS({L},{crit("Find")},{V},TRUE),"")',
            f'=IFERROR(AVERAGEIFS({Rr},{crit("Find")},{V},TRUE),"")',
            f'=COUNTIFS({crit("Find")},{V},TRUE)',
            f'=COUNTIFS({crit("Find")},{BL},TRUE)',
            f"=Trials!R{tr}", "=$B$6" if has_base else None, "=$B$7" if has_base else None,
        ]
        for j, v in enumerate(cells, 1):
            c = wp.cell(row=r, column=j, value=v); c.font = F; c.border = THIN
            c.alignment = Alignment(horizontal="center")
            if i % 2:
                c.fill = BAND
        for col, f in ((5, "0.00"), (6, "+0.00;-0.00;0.00"), (7, "0.00"), (8, "+0.00;-0.00;0.00"), (9, "+0.0%;-0.0%;0.0%"),
                       (10, "0.00"), (11, "0.00"), (12, "0.00"), (13, "0.00"), (17, "0.00"), (18, "0.00")):
            wp.cell(row=r, column=col).number_format = f
    last = 11 + max(len(trials), 1)
    wp.cell(row=last + 1, column=1, value="Δ = mean − baseline for that screen. Positive Δ (bigger pupil) suggests more mental effort. "
            "Blank cells = no valid reading in that game.").font = FN
    wp.cell(row=last + 2, column=1, value="Mean of all games").font = FB
    for col in (5, 6, 7, 8, 9):
        L_ = get_column_letter(col)
        c = wp.cell(row=last + 2, column=col, value=f'=IFERROR(AVERAGE({L_}12:{L_}{last}),"")')
        c.font = FB; c.alignment = Alignment(horizontal="center")
        c.number_format = wp.cell(row=12, column=col).number_format
    _widths(wp, [8, 6, 7, 7, 13, 12, 12, 11, 11, 10, 10, 11, 11, 10, 9, 12, 11, 10])
    wp.freeze_panes = "A12"

    if trials:
        lc = LineChart()
        lc.title = "Pupil diameter per game (mm)"; lc.y_axis.title = "mm"; lc.x_axis.title = "Game"
        for col in ((5, 7, 17, 18) if has_base else (5, 7)):
            lc.add_data(Reference(wp, min_col=col, min_row=11, max_row=last), titles_from_data=True)
        lc.set_categories(Reference(wp, min_col=1, min_row=12, max_row=last))
        for k, sr in enumerate(lc.series):
            sr.smooth = False
            if k >= 2:
                sr.graphicalProperties.line.dashStyle = "dash"
        lc.height, lc.width = 8, 18
        charts = [(lc, f"A{last + 5}")]
        if samples:
            tc = LineChart()
            tc.title = "Pupil diameter over the session (every reading)"; tc.y_axis.title = "mm"; tc.x_axis.title = "Reading"
            tc.add_data(Reference(wb["Pupil samples"], min_col=5, min_row=1, max_row=ns), titles_from_data=True)
            tc.series[0].smooth = False; tc.series[0].graphicalProperties.line.width = 9000
            tc.height, tc.width = 8, 18
            tc.legend = None
            charts.append((tc, f"J{last + 5}"))
        for c, anchor in charts:
            c.roundedCorners = False
            c.title.overlay = False
            if c.legend is not None:
                c.legend.position = "b"; c.legend.overlay = False
            c.x_axis.delete = False; c.y_axis.delete = False
            c.x_axis.title.overlay = False; c.y_axis.title.overlay = False
            wp.add_chart(c, anchor)


def build(data: dict, path: str) -> str:
    trials = data.get("trials") or []
    samples = data.get("samples") or []
    levels = data.get("levels") or []
    meta = data.get("meta") or {}
    wb = Workbook()

    # ------------------------------------------------------------- Trials ----
    wt = wb.active
    wt.title = "Trials"
    cols = ["Trial", "Set", "Game", "Level played", "Level name", "Target bus(es)", "Target destination(s)",
            "Selected bus(es)", "Selected destination(s)", "Correct (1/0)", "Search time (s)", "Changes of mind",
            "Remember pupil (mm)", "Find pupil (mm)", "Find baseline (mm)", "Find Δ vs baseline (mm)",
            "Workload index", "Workload level", "Level change", "Decision", "Selected by", "Confirmed by", "EMG onset after selection (s)"]
    _header(wt, 1, cols)
    for i, t in enumerate(trials):
        r = i + 2
        lvl = _num(t.get("level_played"))
        vals = [i + 1, _num(t.get("set")), _num(t.get("rep")), lvl,
                levels[int(lvl) - 1]["label"] if lvl and 0 < lvl <= len(levels) else "",
                t.get("target", ""), t.get("target_dest", ""), t.get("selected", ""), t.get("selected_dest", ""),
                1 if str(t.get("correct")).lower() == "true" else 0,
                (_num(t.get("search_time_ms")) or 0) / 1000 if _num(t.get("search_time_ms")) is not None else None,
                _num(t.get("reselections")) or 0,
                _num(t.get("mem_pupil_mm")), _num(t.get("search_pupil_mm")), _num(t.get("base_search_mm")),
                None, _num(t.get("search_index")), (t.get("search_level") or "").upper() or "PAUSED",
                _num(t.get("level_change")), t.get("level_reason", ""), t.get("lock_source", ""),
                t.get("confirm_by", ""), _num(t.get("emg_onset_after_lock_s"))]
        for j, v in enumerate(vals, 1):
            c = wt.cell(row=r, column=j, value=v)
            c.font, c.border = F, THIN
        wt.cell(row=r, column=16, value=f'=IF(AND(ISNUMBER(N{r}),ISNUMBER(O{r})),N{r}-O{r},"")').font = F
        for col, fmt in ((11, "0.0"), (13, "0.00"), (14, "0.00"), (15, "0.00"), (16, "+0.00;-0.00;0.00"), (17, "0.00"), (19, "+0;-0;0"), (23, "0.00")):
            wt.cell(row=r, column=col).number_format = fmt
        if i % 2:
            for j in range(1, len(cols) + 1):
                wt.cell(row=r, column=j).fill = BAND
    n = len(trials)
    last = max(n + 1, 2)
    _widths(wt, [7, 6, 7, 9, 20, 12, 22, 12, 22, 10, 10, 10, 12, 12, 12, 13, 11, 12, 10, 44, 12, 11, 14])
    wt.freeze_panes = "A2"
    if n:
        wt.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{last}"

    # ------------------------------------------------------------ Summary ----
    ws = wb.create_sheet("Summary", 0)
    ws["A1"] = "Catch Your Bus — session summary"; ws["A1"].font = FT
    ws["A2"] = "Pupil workload measured with PupilSense (webcam); gaze with WebGazer. Research prototype — not a clinical measure."
    ws["A2"].font = FN

    info = [
        ("Participant", meta.get("participant") or "—"),
        ("Session date", meta.get("date") or datetime.now().strftime("%Y-%m-%d")),
        ("Start time", meta.get("start") or ""),
        ("End time", meta.get("end") or ""),
        ("Protocol", f'{meta.get("sets", "?")} sets × {meta.get("reps", "?")} games'),
        ("Grid layout", meta.get("grid") or ""),
        ("Gaze calibration", meta.get("gazeQuality") or "—"),
        ("Gaze error, median (px)", _num(meta.get("gazeMedianPx"))),
        ("Pupil baseline – Remember screen (mm)", _num(meta.get("baseMemory"))),
        ("Pupil baseline – Find screen (mm)", _num(meta.get("baseSearch"))),
        ("Light check Δ black − white (mm)", _num(meta.get("lightDiff"))),
        ("Camera brightness locked", "Yes" if meta.get("exposureLocked") else "No"),
        ("EMG source", meta.get("emgSource") or "not used"),
        ("EMG relaxed baseline", meta.get("emgBaseline") or "—"),
        ("EMG activation threshold (ADC)", _num(meta.get("emgThreshold"))),
        ("EMG filter (on the Arduino)", meta.get("emgFilter") or "—"),
        ("EMG missed samples", _num(meta.get("emgMissed"))),
    ]
    ws["A4"] = "Session"; ws["A4"].font = FS
    for i, (k, v) in enumerate(info):
        ws.cell(row=5 + i, column=1, value=k).font = F
        c = ws.cell(row=5 + i, column=2, value=v); c.font = FB
        c.alignment = Alignment(horizontal="left")
        if isinstance(v, float):
            c.number_format = "0.00" if "mm" in k else "0"
    ws.cell(row=5 + len(info), column=1, value="Light check: ≥ 0.30 mm = pupil tracked well; < 0.10 mm = workload levels unreliable").font = FN

    R = f"Trials!$A$2:$A${last}"
    rng = lambda col: f"Trials!${col}$2:${col}${last}"
    RH = 5 + len(info) + 2                      # "Results" heading row
    G, C_ = f"B{RH + 1}", f"B{RH + 2}"          # games played / correct cells
    ws.cell(row=RH, column=1, value="Results").font = FS
    results = [
        ("Games played", f"=COUNT({R})", "0"),
        ("Correct", f"=SUM({rng('J')})", "0"),
        ("Accuracy", f'=IFERROR({C_}/{G},"")', "0%"),
        ("Mean search time (s)", f'=IFERROR(AVERAGE({rng("K")}),"")', "0.0"),
        ("Highest level reached", f'=IFERROR(MAX({rng("D")}),"")', "0"),
        ("Final level", f'=IFERROR(INDEX({rng("D")},{G})+INDEX({rng("S")},{G}),"")', "0"),
        ("Mean Find Δ pupil vs baseline (mm)", f'=IFERROR(AVERAGE({rng("P")}),"")', "+0.00;-0.00;0.00"),
        ("Workload LOW", f'=COUNTIF({rng("R")},"LOW")', "0"),
        ("Workload MEDIUM", f'=COUNTIF({rng("R")},"MEDIUM")', "0"),
        ("Workload HIGH", f'=COUNTIF({rng("R")},"HIGH")', "0"),
        ("No reliable reading (PAUSED)", f'=COUNTIF({rng("R")},"PAUSED")', "0"),
        ("Total changes of mind", f'=SUM({rng("L")})', "0"),
    ]
    for i, (k, f, fmt) in enumerate(results):
        ws.cell(row=RH + 1 + i, column=1, value=k).font = F
        c = ws.cell(row=RH + 1 + i, column=2, value=f); c.font = FB; c.number_format = fmt
        c.alignment = Alignment(horizontal="left")

    # per set
    r0 = RH + len(results) + 4
    ws.cell(row=r0 - 1, column=1, value="By set").font = FS
    _header(ws, r0, ["Set", "Games", "Correct", "Accuracy", "Mean search (s)", "Mean Find Δ pupil (mm)", "Start level", "End level"])
    sets = sorted({int(_num(t.get("set"))) for t in trials if _num(t.get("set"))}) or [1]
    for i, sv in enumerate(sets):
        r = r0 + 1 + i
        ws.cell(row=r, column=1, value=sv)
        ws.cell(row=r, column=2, value=f'=COUNTIF({rng("B")},A{r})')
        ws.cell(row=r, column=3, value=f'=SUMIF({rng("B")},A{r},{rng("J")})')
        ws.cell(row=r, column=4, value=f'=IFERROR(C{r}/B{r},"")').number_format = "0%"
        ws.cell(row=r, column=5, value=f'=IFERROR(AVERAGEIF({rng("B")},A{r},{rng("K")}),"")').number_format = "0.0"
        ws.cell(row=r, column=6, value=f'=IFERROR(AVERAGEIF({rng("B")},A{r},{rng("P")}),"")').number_format = "+0.00;-0.00;0.00"
        ws.cell(row=r, column=7, value=f'=IFERROR(INDEX({rng("D")},MATCH(A{r},{rng("B")},0)),"")')
        ws.cell(row=r, column=8, value=f'=IFERROR(INDEX({rng("D")},MATCH(A{r},{rng("B")},0)+B{r}-1)+INDEX({rng("S")},MATCH(A{r},{rng("B")},0)+B{r}-1),"")')
        for j in range(1, 9):
            ws.cell(row=r, column=j).font = F
            ws.cell(row=r, column=j).border = THIN
            ws.cell(row=r, column=j).alignment = Alignment(horizontal="center")

    # per level
    r1 = r0 + len(sets) + 4
    ws.cell(row=r1 - 1, column=1, value="By difficulty level").font = FS
    _header(ws, r1, ["Level", "Name", "Games", "Accuracy", "Mean search (s)", "Mean Find Δ pupil (mm)", "LOW", "MEDIUM", "HIGH"])
    for i, L in enumerate(levels):
        r = r1 + 1 + i
        ws.cell(row=r, column=1, value=i + 1)
        ws.cell(row=r, column=2, value=L.get("label", ""))
        ws.cell(row=r, column=3, value=f'=COUNTIF({rng("D")},A{r})')
        ws.cell(row=r, column=4, value=f'=IFERROR(AVERAGEIF({rng("D")},A{r},{rng("J")}),"")').number_format = "0%"
        ws.cell(row=r, column=5, value=f'=IFERROR(AVERAGEIF({rng("D")},A{r},{rng("K")}),"")').number_format = "0.0"
        ws.cell(row=r, column=6, value=f'=IFERROR(AVERAGEIF({rng("D")},A{r},{rng("P")}),"")').number_format = "+0.00;-0.00;0.00"
        for j, lab in enumerate(("LOW", "MEDIUM", "HIGH")):
            ws.cell(row=r, column=7 + j, value=f'=COUNTIFS({rng("D")},A{r},{rng("R")},"{lab}")')
        for j in range(1, 10):
            ws.cell(row=r, column=j).font = F
            ws.cell(row=r, column=j).border = THIN
            ws.cell(row=r, column=j).alignment = Alignment(horizontal="left" if j == 2 else "center")
    ws.cell(row=r1 + len(levels) + 1, column=1,
            value=f"Levels change after each game: wrong or HIGH → down 1; {(meta.get('settings') or {}).get('raiseAfterLow', 1)}× LOW + correct → up 1; MEDIUM + correct → stay.").font = FN
    _widths(ws, [36, 22, 10, 12, 15, 20, 11, 11, 11])

    # charts
    if n:
        ch = LineChart()
        ch.title = "Difficulty level per game"; ch.y_axis.title = "Level"; ch.x_axis.title = "Game"
        ch.add_data(Reference(wt, min_col=4, min_row=1, max_row=last), titles_from_data=True)
        ch.set_categories(Reference(wt, min_col=1, min_row=2, max_row=last))
        ch.y_axis.scaling.min = 0; ch.y_axis.scaling.max = max(len(levels), 1)
        ch.height, ch.width = 7, 15
        bc = BarChart()
        bc.title = "Find-phase pupil change vs baseline (mm)"; bc.y_axis.title = "Δ mm"; bc.x_axis.title = "Game"
        bc.add_data(Reference(wt, min_col=16, min_row=1, max_row=last), titles_from_data=True)
        bc.set_categories(Reference(wt, min_col=1, min_row=2, max_row=last))
        bc.height, bc.width = 7, 15
        for c in (ch, bc):
            c.roundedCorners = False
            c.legend = None
            c.title.overlay = False
            c.x_axis.delete = False; c.y_axis.delete = False
            c.x_axis.title.overlay = False; c.y_axis.title.overlay = False
        ws.add_chart(ch, "D4")
        ws.add_chart(bc, "D18")

    # ------------------------------------------------------------ Samples ----
    wsm = wb.create_sheet("Pupil samples")
    scol = ["Time", "Phase", "Set", "Game", "Pupil (mm)", "Left (mm)", "Right (mm)", "Blink", "Valid",
            "After stand-up", "Gaze x", "Gaze y", "Light", "Face height", "Screen", "Seconds from start"]
    _header(wsm, 1, scol)
    t0 = None
    for i, s in enumerate(samples):
        try:
            ts = datetime.fromisoformat(str(s.get("time")).replace("Z", "+00:00")).timestamp()
            t0 = ts if t0 is None else t0
            secs = round(ts - t0, 2)
        except ValueError:
            secs = None
        ph = s.get("phase")
        scr = SCREEN_OF.get(ph, "Other")
        vals = [s.get("time"), ph, _num(s.get("set")), _num(s.get("rep")), _num(s.get("pupil_mm")),
                _num(s.get("left_mm")), _num(s.get("right_mm")), str(s.get("blink")).lower() == "true",
                str(s.get("valid")).lower() == "true", str(s.get("post_movement")).lower() == "true",
                _num(s.get("gaze_x")), _num(s.get("gaze_y")), _num(s.get("light")), _num(s.get("face_h")), scr, secs]
        for j, v in enumerate(vals, 1):
            wsm.cell(row=i + 2, column=j, value=v).font = F
    _widths(wsm, [24, 11, 6, 7, 10, 10, 10, 8, 8, 12, 9, 9, 8, 11, 10, 11])
    wsm.cell(row=1, column=15).comment = Comment("Remember = memory phase; Find = search + confirm phases; "
                                                 "Baseline = calibration cross; Other = movement, rest, warm-up.", "PupilSense")
    _pupil_sheet(wb, trials, samples, meta)
    wsm.freeze_panes = "A2"

    # ---------------------------------------------------------------- EMG ----
    emg = data.get("emg") or []
    ev = data.get("emg_events") or []
    if emg or ev:
        we = wb.create_sheet("EMG")
        _header(we, 1, ["Time", "Phase", "Set", "Game", "ADC", "Envelope (ADC)", "Threshold (ADC)", "Active"])
        for i, r in enumerate(emg):
            vals = [r.get("time"), r.get("phase"), _num(r.get("set")), _num(r.get("rep")), _num(r.get("adc")),
                    _num(r.get("envelope")), _num(r.get("threshold")), str(r.get("active")).lower() == "true"]
            for j, v in enumerate(vals, 1):
                we.cell(row=i + 2, column=j, value=v).font = F
        _widths(we, [24, 11, 6, 7, 8, 13, 14, 8])
        we.freeze_panes = "A2"
        we.cell(row=1, column=10, value="EMG events").font = FS
        _header(we, 2, ["Time", "Event", "Phase", "Set", "Game", "Detail"], col=10)
        for i, e in enumerate(ev):
            vals = [e.get("time"), e.get("type"), e.get("phase"), _num(e.get("set")), _num(e.get("rep")), e.get("detail", "")]
            for j, v in enumerate(vals):
                we.cell(row=i + 3, column=10 + j, value=v).font = F
        for col, w in zip("JKLMNO", (24, 16, 11, 6, 7, 46)):
            we.column_dimensions[col].width = w
        we.cell(row=1, column=1).comment = Comment("EMG envelope at 20 readings/s (ADC counts of the sensor envelope, not microvolts). "
                                                   "With BN5213_EMG_filtered.ino: raw EMG sampled at 1000 Hz, band-pass 20-450 Hz, notch 50/100/150 Hz, rectified and averaged to 200 Hz on the Arduino. Detector: baseline mean + max(3 SD, 10 ADC); onset held 30 ms.", "EMG")

    # --------------------------------------------------------- Levels/settings ----
    wl = wb.create_sheet("Levels and settings")
    _header(wl, 1, ["Level", "Name", "Buses to remember", "Shown for (s)", "Blank delay (s)", "Other buses", "Destination", "Decoys"])
    for i, L in enumerate(levels):
        two = bool(L.get("twoBus"))
        decoys = ("frames with one thing wrong: a wrong destination, two destinations swapped, or a look-alike number" if two
                  else f'{L.get("duplicates")} same-number + {L.get("duplicates")} same-destination' if L.get("destination") else "–")
        vals = [i + 1, L.get("label"), (L.get("buses") or 2) if two else 1, (L.get("memoryMs") or 0) / 1000, (L.get("delayMs") or 0) / 1000,
                {"low": "random routes", "mid": "half look-alikes", "high": "all look-alikes"}.get(L.get("similarity"), L.get("similarity")),
                "Yes" if L.get("destination") else "No", decoys]
        for j, v in enumerate(vals, 1):
            wl.cell(row=i + 2, column=j, value=v).font = F
        wl.cell(row=i + 2, column=4).number_format = "0.0"
        wl.cell(row=i + 2, column=5).number_format = "0.0"
    r = len(levels) + 4
    wl.cell(row=r, column=1, value="Settings").font = FS
    for k, v in (meta.get("settings") or {}).items():
        r += 1
        wl.cell(row=r, column=1, value=str(k)).font = F
        wl.cell(row=r, column=2, value=v if isinstance(v, (int, float, str, bool)) else str(v)).font = F
    _widths(wl, [8, 24, 12, 12, 13, 17, 12, 52])

    wb.calculation.fullCalcOnLoad = True
    wb.save(path)
    return path
