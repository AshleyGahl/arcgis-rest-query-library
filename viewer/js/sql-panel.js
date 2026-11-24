import { tsql } from './rest.js';
import { showResults, showError } from './results.js';

const $ = (id) => document.getElementById(id);

export function initSqlPanel() {
  $('sqlRun').onclick = async () => {
    try {
      const r = await tsql($('sqlText').value);
      $('sqlTranslated').textContent = `SQLite: ${r.sqlite}`;
      showResults({ title: 'T-SQL (mock /sql extension)', rows: r.rows, columns: r.columns });
    } catch (e) {
      $('sqlTranslated').textContent = '';
      showError('T-SQL', e);
    }
  };
}
