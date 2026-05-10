#!/usr/bin/env node
/**
 * VA/NC Concert Scraper
 * Runs via GitHub Actions on a daily schedule.
 * Scrapes venue websites + queries Ticketmaster & SeatGeek APIs.
 * Outputs a unified shows.json for the static frontend.
 *
 * Required env vars:
 *   TICKETMASTER_API_KEY
 *   SEATGEEK_CLIENT_ID
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TM_KEY = process.env.TICKETMASTER_API_KEY || '';
const SG_ID = process.env.SEATGEEK_CLIENT_ID || '';

// ─── Venue Configs ───────────────────────────────────────────────
const VENUES = [
  // Virginia
  {
    id: 'the-national-rva',
    name: 'The National',
    city: 'Richmond',
    state: 'VA',
    url: 'https://www.thenationalva.com/schedule',
    scraper: 'aegPresents',
  },
  {
    id: 'the-broadberry-rva',
    name: 'The Broadberry',
    city: 'Richmond',
    state: 'VA',
    url: 'https://thebroadberry.com/events/',
    scraper: 'broadberry',
  },
  {
    id: 'richmond-music-hall',
    name: 'Richmond Music Hall',
    city: 'Richmond',
    state: 'VA',
    url: 'https://thebroadberry.com/events/category/richmond-music-hall/',
    scraper: 'broadberry',
  },
  {
    id: 'canal-club-rva',
    name: 'Canal Club',
    city: 'Richmond',
    state: 'VA',
    url: 'https://www.canalclub.com/calendar',
    scraper: 'generic',
  },
  {
    id: 'the-camel-rva',
    name: 'The Camel',
    city: 'Richmond',
    state: 'VA',
    url: 'https://www.thecamel.org/calendar',
    scraper: 'generic',
  },
  {
    id: 'the-tin-pan-rva',
    name: 'The Tin Pan',
    city: 'Richmond',
    state: 'VA',
    url: 'https://tinpanrva.com/events/',
    scraper: 'generic',
  },
  {
    id: 'ember-music-hall',
    name: 'Ember Music Hall',
    city: 'Richmond',
    state: 'VA',
    url: 'https://www.emberrva.com/events',
    scraper: 'generic',
  },
  {
    id: 'the-norva',
    name: 'The NorVa',
    city: 'Norfolk',
    state: 'VA',
    url: 'https://www.thenorva.com/schedule',
    scraper: 'aegPresents',
  },
  {
    id: 'elevation-27',
    name: 'Elevation 27',
    city: 'Virginia Beach',
    state: 'VA',
    url: 'https://www.elevation27.com/events',
    scraper: 'generic',
  },
  {
    id: 'ashland-theatre',
    name: 'The Ashland Theatre',
    city: 'Ashland',
    state: 'VA',
    url: 'https://theashlandtheatre.com/events/',
    scraper: 'generic',
  },

  // North Carolina
  {
    id: 'cats-cradle',
    name: "Cat's Cradle",
    city: 'Carrboro',
    state: 'NC',
    url: 'https://catscradle.com/events/',
    scraper: 'catsCradle',
  },
  {
    id: 'motorco-durham',
    name: 'Motorco Music Hall',
    city: 'Durham',
    state: 'NC',
    url: 'https://motorcomusic.com/events/',
    scraper: 'generic',
  },
  {
    id: 'orange-peel-avl',
    name: 'The Orange Peel',
    city: 'Asheville',
    state: 'NC',
    url: 'https://theorangepeel.net/events/',
    scraper: 'generic',
  },
  {
    id: 'fillmore-charlotte',
    name: 'The Fillmore Charlotte',
    city: 'Charlotte',
    state: 'NC',
    url: 'https://www.fillmorenc.com/events',
    scraper: 'generic',
  },
  {
    id: 'local-506',
    name: 'Local 506',
    city: 'Chapel Hill',
    state: 'NC',
    url: 'https://local506.com/events/',
    scraper: 'generic',
  },
  {
    id: 'the-pinhook',
    name: 'The Pinhook',
    city: 'Durham',
    state: 'NC',
    url: 'https://www.thepinhook.com/calendar',
    scraper: 'generic',
  },
  {
    id: 'grey-eagle-avl',
    name: 'The Grey Eagle',
    city: 'Asheville',
    state: 'NC',
    url: 'https://thegreyeagle.com/events/',
    scraper: 'generic',
  },
  {
    id: 'pour-house-raleigh',
    name: 'The Pour House Music Hall',
    city: 'Raleigh',
    state: 'NC',
    url: 'https://www.thepourhousemusichall.com/events',
    scraper: 'generic',
  },
  {
    id: 'lincoln-theatre-raleigh',
    name: 'Lincoln Theatre',
    city: 'Raleigh',
    state: 'NC',
    url: 'https://www.lincolntheatre.com/events',
    scraper: 'generic',
  },
  {
    id: 'haw-river-ballroom',
    name: 'Haw River Ballroom',
    city: 'Saxapahaw',
    state: 'NC',
    url: 'https://hawriverballroom.com/events/',
    scraper: 'generic',
  },
];

// ─── Utility ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeDate(str) {
  if (!str) return null;
  // Try ISO
  const d = new Date(str);
  if (!isNaN(d)) return d.toISOString().split('T')[0];
  return null;
}

function dedupe(shows) {
  const seen = new Map();
  for (const s of shows) {
    // Key on lowercase name + date + city
    const key = `${(s.artist || s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${s.date}|${(s.city || '').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.set(key, s);
    } else {
      // Merge: prefer the one with more info
      const existing = seen.get(key);
      if (!existing.ticketUrl && s.ticketUrl) existing.ticketUrl = s.ticketUrl;
      if (!existing.price && s.price) existing.price = s.price;
      if (!existing.genre && s.genre) existing.genre = s.genre;
      if (s.source && !existing.source.includes(s.source)) {
        existing.source += `, ${s.source}`;
      }
    }
  }
  return [...seen.values()];
}

// ─── Venue Scrapers ──────────────────────────────────────────────

/**
 * Cat's Cradle — WordPress with server-rendered event list.
 * Events are in .rhpSingleEvent containers.
 */
async function scrapeCatsCradle(page, venue) {
  const shows = [];
  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    const events = await page.evaluate(() => {
      const items = [];
      // Cat's Cradle uses .rhpSingleEvent or similar event blocks
      document.querySelectorAll('.rhpSingleEvent, .eventWrapper, .eventItem, article.type-event').forEach(el => {
        const titleEl = el.querySelector('h2 a, h3 a, .event-name a, .headliners a');
        const dateEl = el.querySelector('.eventDateList, .eventDate, time, .date');
        const venueEl = el.querySelector('.eventVenueLink, .venue-name, .rhp-event-venue a');
        const linkEl = el.querySelector('a[href*="/event/"]') || titleEl;
        const ticketEl = el.querySelector('a[href*="etix.com"], a[href*="ticket"]');

        if (titleEl) {
          items.push({
            name: titleEl.textContent.trim(),
            date: dateEl ? dateEl.getAttribute('datetime') || dateEl.textContent.trim() : null,
            venue: venueEl ? venueEl.textContent.trim() : null,
            url: linkEl ? linkEl.href : null,
            ticketUrl: ticketEl ? ticketEl.href : null,
          });
        }
      });
      return items;
    });

    for (const ev of events) {
      const parsedDate = parseFlexibleDate(ev.date);
      shows.push({
        name: ev.name,
        date: parsedDate,
        venue: ev.venue || venue.name,
        city: venue.city,
        state: venue.state,
        ticketUrl: ev.ticketUrl || ev.url,
        source: venue.id,
        genre: null,
        price: null,
      });
    }
  } catch (err) {
    console.error(`[${venue.id}] scrape failed:`, err.message);
  }
  return shows;
}

/**
 * AEG Presents venues (The National, The NorVa).
 * These load events via JS; we wait for event cards to appear.
 */
async function scrapeAegPresents(page, venue) {
  const shows = [];
  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    const events = await page.evaluate(() => {
      const items = [];
      // AEG sites use various selectors for event cards
      document.querySelectorAll('.eventItem, .schedule-item, .event-card, [class*="EventCard"], [class*="event-item"], .content-card').forEach(el => {
        const titleEl = el.querySelector('h3, h2, .event-title, .title, [class*="title"]');
        const dateEl = el.querySelector('time, .date, [class*="date"], [datetime]');
        const linkEl = el.querySelector('a[href*="event"], a[href*="ticket"]');

        if (titleEl) {
          items.push({
            name: titleEl.textContent.trim(),
            date: dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : null,
            url: linkEl ? linkEl.href : null,
          });
        }
      });
      return items;
    });

    for (const ev of events) {
      shows.push({
        name: ev.name,
        date: parseFlexibleDate(ev.date),
        venue: venue.name,
        city: venue.city,
        state: venue.state,
        ticketUrl: ev.url,
        source: venue.id,
        genre: null,
        price: null,
      });
    }
  } catch (err) {
    console.error(`[${venue.id}] scrape failed:`, err.message);
  }
  return shows;
}

/**
 * Broadberry sites — WordPress with event list pages.
 */
async function scrapeBroadberry(page, venue) {
  const shows = [];
  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    const events = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('.eventItem, .event-listing, article, .rhpSingleEvent, .eventWrapper').forEach(el => {
        const titleEl = el.querySelector('h2 a, h3 a, .event-title a, .headliners a, a[class*="title"]');
        const dateEl = el.querySelector('.eventDate, time, .date, [datetime]');
        const venueEl = el.querySelector('.eventVenue, .venue, .location');
        const linkEl = el.querySelector('a[href*="/event/"]') || titleEl;
        const ticketEl = el.querySelector('a[href*="ticket"], a[href*="etix"]');

        if (titleEl) {
          items.push({
            name: titleEl.textContent.trim(),
            date: dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : null,
            venue: venueEl ? venueEl.textContent.trim() : null,
            url: linkEl ? linkEl.href : null,
            ticketUrl: ticketEl ? ticketEl.href : null,
          });
        }
      });
      return items;
    });

    for (const ev of events) {
      shows.push({
        name: ev.name,
        date: parseFlexibleDate(ev.date),
        venue: ev.venue || venue.name,
        city: venue.city,
        state: venue.state,
        ticketUrl: ev.ticketUrl || ev.url,
        source: venue.id,
        genre: null,
        price: null,
      });
    }
  } catch (err) {
    console.error(`[${venue.id}] scrape failed:`, err.message);
  }
  return shows;
}

/**
 * Generic scraper — tries common event page patterns.
 * Works as a best-effort fallback.
 */
async function scrapeGeneric(page, venue) {
  const shows = [];
  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    const events = await page.evaluate(() => {
      const items = [];
      // Try a wide set of common selectors
      const selectors = [
        '.eventItem', '.event-listing', '.event-card', '.eventWrapper',
        '.rhpSingleEvent', '[class*="EventCard"]', '[class*="event-item"]',
        'article.event', 'article.type-event', '.shows-list-item',
        '.list-item', '.tribe-events-single', '.event-row',
        '.show-card', '.show-listing', '.concert-item',
      ];

      const container = document.querySelector(selectors.join(', '));
      if (!container) {
        // Fallback: look for any links with date-like content nearby
        document.querySelectorAll('a[href*="event"], a[href*="show"], a[href*="ticket"]').forEach(a => {
          const text = a.textContent.trim();
          if (text.length > 3 && text.length < 200) {
            const parent = a.closest('div, li, article, section');
            const dateEl = parent?.querySelector('time, [datetime], .date, [class*="date"]');
            items.push({
              name: text,
              date: dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : null,
              url: a.href,
            });
          }
        });
        return items;
      }

      document.querySelectorAll(selectors.join(', ')).forEach(el => {
        const titleEl = el.querySelector('h2, h3, h4, .title, .event-title, .headliners, [class*="title"] a, [class*="name"]');
        const dateEl = el.querySelector('time, [datetime], .date, [class*="date"]');
        const linkEl = el.querySelector('a');
        const ticketEl = el.querySelector('a[href*="ticket"], a[href*="etix"], a[href*="eventbrite"], a[href*="axs.com"]');

        if (titleEl) {
          items.push({
            name: titleEl.textContent.trim(),
            date: dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : null,
            url: linkEl ? linkEl.href : null,
            ticketUrl: ticketEl ? ticketEl.href : null,
          });
        }
      });

      return items;
    });

    for (const ev of events) {
      if (ev.name && ev.name.length > 2) {
        shows.push({
          name: ev.name,
          date: parseFlexibleDate(ev.date),
          venue: venue.name,
          city: venue.city,
          state: venue.state,
          ticketUrl: ev.ticketUrl || ev.url,
          source: venue.id,
          genre: null,
          price: null,
        });
      }
    }
  } catch (err) {
    console.error(`[${venue.id}] scrape failed:`, err.message);
  }
  return shows;
}

/**
 * Parse dates in various formats venue sites use.
 */
function parseFlexibleDate(raw) {
  if (!raw) return null;
  raw = raw.trim();

  // Already ISO-ish
  const iso = normalizeDate(raw);
  if (iso) return iso;

  // "Sat, May 09" / "May 09" / "May 9, 2026"
  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };

  // Remove day-of-week prefix
  raw = raw.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[,.]?\s*/i, '');

  // "May 09, 2026" or "May 09 2026" or "May 09"
  const m1 = raw.match(/^(\w+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/i);
  if (m1) {
    const mon = monthNames[m1[1].toLowerCase().slice(0, 3)];
    if (mon !== undefined) {
      const day = parseInt(m1[2]);
      const year = m1[3] ? parseInt(m1[3]) : new Date().getFullYear();
      const d = new Date(year, mon, day);
      return d.toISOString().split('T')[0];
    }
  }

  // "09/05/2026" or "05-09-2026"
  const m2 = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m2) {
    const d = new Date(parseInt(m2[3]), parseInt(m2[1]) - 1, parseInt(m2[2]));
    return d.toISOString().split('T')[0];
  }

  return null;
}

// ─── API Sources ─────────────────────────────────────────────────

async function fetchTicketmaster() {
  if (!TM_KEY) {
    console.log('[ticketmaster] No API key, skipping.');
    return [];
  }

  const shows = [];
  const states = ['VA', 'NC'];
  const now = new Date();
  const future = new Date();
  future.setMonth(future.getMonth() + 3);

  for (const state of states) {
    let page = 0;
    let totalPages = 1;

    while (page < totalPages && page < 5) {
      try {
        const params = new URLSearchParams({
          apikey: TM_KEY,
          classificationName: 'music',
          stateCode: state,
          startDateTime: now.toISOString().split('.')[0] + 'Z',
          endDateTime: future.toISOString().split('.')[0] + 'Z',
          size: '100',
          page: String(page),
          sort: 'date,asc',
        });

        const resp = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
        if (!resp.ok) {
          console.error(`[ticketmaster] HTTP ${resp.status} for ${state} page ${page}`);
          break;
        }

        const data = await resp.json();
        totalPages = data.page?.totalPages || 1;
        const events = data._embedded?.events || [];

        for (const ev of events) {
          const venue = ev._embedded?.venues?.[0];
          const genre = ev.classifications?.[0]?.genre?.name;
          const priceMin = ev.priceRanges?.[0]?.min;

          shows.push({
            name: ev.name,
            date: ev.dates?.start?.localDate || null,
            time: ev.dates?.start?.localTime || null,
            venue: venue?.name || 'TBA',
            city: venue?.city?.name || '',
            state: venue?.state?.stateCode || state,
            ticketUrl: ev.url || null,
            source: 'ticketmaster',
            genre: genre && genre !== 'Undefined' ? genre : null,
            price: priceMin ? `$${Math.round(priceMin)}+` : null,
          });
        }

        page++;
        await sleep(250); // Rate limit
      } catch (err) {
        console.error(`[ticketmaster] error:`, err.message);
        break;
      }
    }
  }

  console.log(`[ticketmaster] fetched ${shows.length} events`);
  return shows;
}

async function fetchSeatGeek() {
  if (!SG_ID) {
    console.log('[seatgeek] No client ID, skipping.');
    return [];
  }

  const shows = [];
  const now = new Date();
  const future = new Date();
  future.setMonth(future.getMonth() + 3);

  // SeatGeek uses lat/lon with range, or state filtering
  // Query major metros in VA and NC
  const metros = [
    { lat: 37.5407, lon: -77.4360, label: 'Richmond VA', range: '50mi' },
    { lat: 36.8529, lon: -75.9780, label: 'Norfolk VA', range: '30mi' },
    { lat: 38.9072, lon: -77.0369, label: 'DC/NoVA', range: '30mi' },
    { lat: 37.2710, lon: -79.9414, label: 'Roanoke VA', range: '40mi' },
    { lat: 35.7796, lon: -78.6382, label: 'Raleigh NC', range: '40mi' },
    { lat: 35.2271, lon: -80.8431, label: 'Charlotte NC', range: '40mi' },
    { lat: 35.9940, lon: -78.8986, label: 'Durham NC', range: '30mi' },
    { lat: 35.5951, lon: -82.5515, label: 'Asheville NC', range: '30mi' },
  ];

  for (const metro of metros) {
    try {
      const params = new URLSearchParams({
        client_id: SG_ID,
        'taxonomies.name': 'concert',
        lat: String(metro.lat),
        lon: String(metro.lon),
        range: metro.range,
        'datetime_utc.gte': now.toISOString(),
        'datetime_utc.lte': future.toISOString(),
        per_page: '100',
        sort: 'datetime_utc.asc',
      });

      const resp = await fetch(`https://api.seatgeek.com/2/events?${params}`);
      if (!resp.ok) {
        console.error(`[seatgeek] HTTP ${resp.status} for ${metro.label}`);
        continue;
      }

      const data = await resp.json();
      for (const ev of (data.events || [])) {
        const v = ev.venue || {};
        // Only include VA and NC
        if (v.state && !['VA', 'NC'].includes(v.state)) continue;

        shows.push({
          name: ev.title || ev.short_title,
          date: ev.datetime_local ? ev.datetime_local.split('T')[0] : null,
          time: ev.datetime_local ? ev.datetime_local.split('T')[1]?.slice(0, 5) : null,
          venue: v.name || 'TBA',
          city: v.city || '',
          state: v.state || '',
          ticketUrl: ev.url || null,
          source: 'seatgeek',
          genre: ev.taxonomies?.[0]?.name || null,
          price: ev.stats?.lowest_price ? `$${ev.stats.lowest_price}+` : null,
        });
      }

      await sleep(300);
    } catch (err) {
      console.error(`[seatgeek] error for ${metro.label}:`, err.message);
    }
  }

  console.log(`[seatgeek] fetched ${shows.length} events`);
  return shows;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`Starting scrape at ${new Date().toISOString()}`);
  let allShows = [];

  // 1. Scrape venue websites
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const scraperMap = {
    catsCradle: scrapeCatsCradle,
    aegPresents: scrapeAegPresents,
    broadberry: scrapeBroadberry,
    generic: scrapeGeneric,
  };

  for (const venue of VENUES) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const scraperFn = scraperMap[venue.scraper] || scrapeGeneric;
    console.log(`[${venue.id}] scraping ${venue.url}...`);

    const shows = await scraperFn(page, venue);
    console.log(`[${venue.id}] found ${shows.length} events`);
    allShows.push(...shows);

    await page.close();
    await sleep(1000); // Be polite
  }

  await browser.close();

  // 2. Fetch API sources
  const tmShows = await fetchTicketmaster();
  const sgShows = await fetchSeatGeek();
  allShows.push(...tmShows, ...sgShows);

  // 3. Clean up
  allShows = allShows.filter(s => s.name && s.date);
  allShows = dedupe(allShows);
  allShows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // 4. Write output
  const output = {
    lastUpdated: new Date().toISOString(),
    count: allShows.length,
    shows: allShows,
  };

  const outPath = path.join(__dirname, '..', 'shows.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDone. Wrote ${allShows.length} events to shows.json`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
