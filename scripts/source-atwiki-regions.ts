import type { CheerioAPI } from 'cheerio';

// AtWiki's region plugin uses three cells: toggle, closed label, hidden body.
// Process inner tables first so nested regions retain their complete contents.
export function materializeAtWikiRegions($: CheerioAPI) {
  let converted = 0;
  for (const table of $('table.atwiki_plugin_region').toArray().reverse()) {
    const cells = $(table).children('tbody').children('tr').first().children('td');
    if (cells.length !== 3) throw new Error('Unrecognized AtWiki region structure');
    const details = $('<details class="archive-source-region"><summary></summary><div class="source-region-body"></div></details>');
    details.children('summary').html(cells.eq(1).html() || '');
    details.children('div').html(cells.eq(2).html() || '');
    if (!/display\s*:\s*none/i.test(cells.eq(2).attr('style') || '')) details.attr('open', '');
    $(table).replaceWith(details);
    converted++;
  }
  return converted;
}
