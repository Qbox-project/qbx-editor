export type ReportTone = 'error' | 'warning' | 'ok' | 'muted';
export interface ReportCell { text: string; tone?: ReportTone }
/** A row of a report table. `link` opens a file from the host; its `id` means nothing to the page. */
export interface ReportRow { cells: (string | ReportCell)[]; link?: { id: string; label: string } }
export interface ReportSection { title: string; description?: string; columns: string[]; rows: ReportRow[]; omitted?: number; empty?: string }
export interface ReportStat { label: string; value: string; tone?: ReportTone }
export interface ReportView { title: string; subtitle: string; stats: ReportStat[]; sections: ReportSection[]; notes: string[] }
export type ReportMessage = { type: 'loading'; title: string; status: string } | { type: 'report'; data: ReportView } | { type: 'error'; message: string };
export type ReportAction = { type: 'ready' | 'refresh' } | { type: 'open'; id: string };

export const MAX_REPORT_ROWS = 1000;

/** `rows` cut to what a report table shows, with the number left out. */
export function boundedRows(rows: ReportRow[]): Pick<ReportSection, 'rows' | 'omitted'> {
    return rows.length > MAX_REPORT_ROWS ? { rows: rows.slice(0, MAX_REPORT_ROWS), omitted: rows.length - MAX_REPORT_ROWS } : { rows };
}
