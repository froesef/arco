#!/usr/bin/env node

/**
 * Generates 1000 unique test prompts from the site's content data.
 * Run: node tools/loadtest/generate-prompts.js
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// --- Content data ---

const PRODUCTS = [
  { name: 'Primo', type: 'espresso machine', category: 'single-boiler', price: 899 },
  { name: 'Doppio', type: 'espresso machine', category: 'dual-boiler', price: 1599 },
  { name: 'Nano', type: 'espresso machine', category: 'compact', price: 649 },
  { name: 'Studio', type: 'espresso machine', category: 'prosumer', price: 2299 },
  { name: 'Studio Pro', type: 'espresso machine', category: 'prosumer', price: 3499 },
  { name: 'Ufficio', type: 'espresso machine', category: 'office', price: 4299 },
  { name: 'Viaggio', type: 'espresso machine', category: 'portable', price: 399 },
  { name: 'Automatico', type: 'espresso machine', category: 'automatic', price: 1899 },
  { name: 'Filtro', type: 'grinder', category: 'filter-grinder', price: 349 },
  { name: 'Preciso', type: 'grinder', category: 'conical-burr', price: 449 },
  { name: 'Macinino', type: 'grinder', category: 'flat-burr', price: 549 },
  { name: 'Zero', type: 'grinder', category: 'single-dose', price: 699 },
];

const MACHINES = PRODUCTS.filter((p) => p.type === 'espresso machine');
const GRINDERS = PRODUCTS.filter((p) => p.type === 'grinder');

const RECIPES = [
  'Classic Espresso', 'Caffe Latte', 'Cappuccino', 'Flat White', 'Pour-Over Coffee',
  'Cold Brew Coffee', 'Americano', 'Cortado', 'Espresso Macchiato', 'Affogato',
  'Caffe Mocha', 'Iced Latte', 'Ristretto', 'Lungo', 'Espresso Romano',
  'Cafe Cubano', 'Piccolo Latte', 'Dirty Chai Latte', 'Oat Milk Cappuccino',
  'Spanish Latte', 'Iced Americano', 'Espresso Tonic', 'Shakerato',
  'Cold Brew Espresso Concentrate', 'Vietnamese Iced Coffee', 'Iced Caramel Macchiato',
  'Espresso Martini', 'Coffee Negroni Mocktail', 'Pumpkin Spice Latte',
  'Gingerbread Latte', 'Lavender Honey Latte',
];

const PERSONAS = [
  { label: 'morning minimalist', context: 'I value calm mornings and simple routines' },
  { label: 'upgrader', context: "I've been making espresso for a while with entry-level equipment" },
  { label: 'craft barista', context: 'I follow the World Barista Championship and know what extraction yield means' },
  { label: 'traveller', context: "I'm a digital nomad who refuses to compromise on coffee quality" },
  { label: 'non-barista', context: 'I want great coffee but have zero interest in the process' },
  { label: 'office manager', context: "I'm responsible for my team's coffee setup" },
];

const BUDGETS = ['under $500', 'under $1000', 'under $1500', 'under $2000', 'under $2500', 'around $3000', 'no budget limit'];
const SPACES = ['small kitchen', 'tiny apartment', 'open-plan kitchen', 'dedicated coffee corner', 'home office', 'rented apartment', 'office break room', 'restaurant', 'food truck'];
const EXPERIENCE_LEVELS = ['complete beginner', 'someone new to espresso', 'intermediate home barista', 'experienced barista', 'professional barista', 'someone switching from capsules', 'someone upgrading from a Moka pot'];
const DRINK_PREFERENCES = ['mostly espresso', 'milk-based drinks like lattes', 'cappuccinos and flat whites', 'pour-over and filter coffee', 'iced drinks', 'a variety of coffee drinks', 'just a simple morning espresso', 'espresso and americanos'];
const SEASONS = ['summer', 'winter', 'autumn', 'spring', 'holiday season'];
const CITIES = ['Milan', 'Tokyo', 'Melbourne', 'Vienna', 'Naples', 'Lisbon', 'Oslo', 'New York', 'London', 'Berlin'];
const PROBLEMS = [
  'my espresso tastes sour', 'my espresso tastes bitter', 'my shots are running too fast',
  'my shots are pulling too slow', 'my grinder produces clumpy grinds', 'I can\'t get consistent shots',
  'my milk won\'t froth properly', 'my machine takes forever to heat up', 'there\'s no crema on my espresso',
  'my espresso is watery', 'the pressure gauge reads too low', 'my machine is leaking',
  'my portafilter is channeling', 'the steam wand won\'t produce enough pressure',
  'my grinder retention is too high', 'my coffee tastes flat and lifeless',
];
const MODIFIERS = ['really', 'honestly', 'actually', 'genuinely', 'seriously'];
const OPENERS = [
  'I\'m looking for', 'Can you recommend', 'What do you suggest for', 'I need help finding',
  'Tell me about', 'What\'s the best', 'I\'m interested in', 'Help me choose',
  'I want to learn about', 'What would you recommend for', 'I\'m curious about',
  'Show me', 'I\'d like to know about', 'What are my options for',
];

// --- Utility ---

let _seed = 42;
function seededRandom() {
  _seed = (_seed * 1664525 + 1013904223) & 0x7fffffff;
  return _seed / 0x7fffffff;
}

function pick(arr) {
  return arr[Math.floor(seededRandom() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => seededRandom() - 0.5);
  return shuffled.slice(0, n);
}

function maybe(str, chance = 0.5) {
  return seededRandom() < chance ? str : '';
}

function oneOf(...args) {
  return args[Math.floor(seededRandom() * args.length)];
}

// --- Prompt generators by category ---

function productSpecific() {
  const p = pick(PRODUCTS);
  const templates = [
    `${pick(OPENERS)} the Arco ${p.name}`,
    `What can you tell me about the ${p.name}?`,
    `Is the Arco ${p.name} a good ${p.type}?`,
    `${p.name} features and specifications`,
    `Who is the Arco ${p.name} ${maybe('really ')}best for?`,
    `How does the ${p.name} compare to other ${p.type}s in its price range?`,
    `What accessories come with the ${p.name}?`,
    `Is the ${p.name} worth $${p.price}?`,
    `What colors does the ${p.name} come in?`,
    `Detailed review of the Arco ${p.name}`,
    `Pros and cons of the ${p.name}`,
    `I'm thinking about buying the ${p.name}${maybe(', is it any good')}`,
    `What's special about the ${p.name} ${p.type}?`,
    `Can the ${p.name} make good ${pick(['lattes', 'cappuccinos', 'espresso', 'milk drinks'])}?`,
    `How long does the ${p.name} take to heat up?`,
  ];
  return { query: pick(templates), category: 'product-specific' };
}

function comparison() {
  const a = pick(MACHINES);
  let b = pick(MACHINES);
  while (b.name === a.name) b = pick(MACHINES);
  const ga = pick(GRINDERS);
  let gb = pick(GRINDERS);
  while (gb.name === ga.name) gb = pick(GRINDERS);

  const templates = [
    `${a.name} vs ${b.name}`,
    `Compare the Arco ${a.name} and ${b.name}`,
    `Should I get the ${a.name} or the ${b.name}?`,
    `What's the difference between the ${a.name} and the ${b.name}?`,
    `${a.name} vs ${b.name} for ${pick(EXPERIENCE_LEVELS)}`,
    `Is the ${b.name} worth the upgrade from the ${a.name}?`,
    `${ga.name} vs ${gb.name} grinder comparison`,
    `Which grinder is better, the ${ga.name} or the ${gb.name}?`,
    `${a.name} or ${b.name} for ${pick(DRINK_PREFERENCES)}`,
    `single boiler vs dual boiler for a ${pick(EXPERIENCE_LEVELS)}`,
    `manual grinder vs the ${pick(GRINDERS).name}`,
    `flat burr vs conical burr grinders — which should I choose?`,
    `${a.name} paired with ${ga.name} vs ${b.name} paired with ${gb.name}`,
    `Is it better to invest in the machine or the grinder?`,
  ];
  return { query: pick(templates), category: 'comparison' };
}

function buyingGuide() {
  const templates = [
    `best espresso machine ${pick(BUDGETS)}`,
    `what grinder should I get ${pick(BUDGETS)}`,
    `best espresso setup for ${pick(EXPERIENCE_LEVELS)}`,
    `${pick(OPENERS)} an espresso machine ${pick(BUDGETS)}`,
    `what's the best value espresso machine you offer?`,
    `I have a budget of about $${Math.floor(seededRandom() * 3000 + 500)} for an espresso setup`,
    `best machine and grinder combo ${pick(BUDGETS)}`,
    `what should I buy first, a good machine or a good grinder?`,
    `essential accessories for a new espresso setup`,
    `complete espresso starter kit recommendations`,
    `what's the minimum I should spend on an espresso machine?`,
    `best gift for a coffee lover ${pick(BUDGETS)}`,
    `gift guide for ${pick(['a coffee lover', 'someone who loves espresso', 'a home barista', 'a dad who loves coffee', 'someone who has everything'])}`,
    `best ${pick(['automatic', 'manual', 'compact', 'portable'])} espresso machine`,
    `which Arco machine has the best bang for the buck?`,
    `I want to stop buying Starbucks — what do I need?`,
  ];
  return { query: pick(templates), category: 'buying-guide' };
}

function useCase() {
  const templates = [
    `best espresso machine for a ${pick(SPACES)}`,
    `espresso machine for ${pick(['a couple', 'a family of four', 'just myself', 'an office of 10 people', 'entertaining guests', 'daily use'])}`,
    `I need a machine that can handle ${pick(['10', '20', '30', '50'])} cups a day`,
    `compact espresso machine that fits on a narrow countertop`,
    `best machine for someone who ${pick(['drinks mostly milk drinks', 'only drinks straight espresso', 'wants to do latte art', 'hates complicated machines', 'wants pressure profiling'])}`,
    `quiet espresso machine for ${pick(['early mornings', 'a shared apartment', 'an office', 'a bedroom setup'])}`,
    `espresso machine I can take ${pick(['camping', 'on road trips', 'traveling', 'to a vacation rental', 'to the office'])}`,
    `best machine for making ${pick(DRINK_PREFERENCES)}`,
    `what's the fastest espresso machine you have?`,
    `I want a machine that doesn't need a plumber to install`,
    `best espresso machine for ${pick(SEASONS)} drinks`,
    `machine for someone who loves ${pick(RECIPES)}`,
    `I make ${pick(['2', '3', '4', '5', '6'])} coffees every morning — which machine?`,
    `best machine with a built-in grinder`,
    `plumb-in espresso machine for a kitchen renovation`,
    `what machine do you recommend for a ${pick(SPACES)} that serves ${pick(DRINK_PREFERENCES)}?`,
    `I need a ${pick(['reliable', 'low-maintenance', 'high-volume', 'quiet', 'fast'])} machine for ${pick(SPACES)}`,
    `best setup for making ${pick(DRINK_PREFERENCES)} in a ${pick(SPACES)}`,
    `I ${pick(MODIFIERS)} want a machine that ${pick(['looks great on the counter', 'is easy to clean', 'heats up fast', 'is super quiet', 'can handle back-to-back drinks'])}`,
    `espresso machine for someone who is ${pick(EXPERIENCE_LEVELS)} and drinks ${pick(DRINK_PREFERENCES)}`,
    `what's the best Arco machine for ${pick(['daily use', 'weekend brewing', 'occasional entertaining', 'serious daily production'])}?`,
    `I drink ${pick(DRINK_PREFERENCES)} — should I get a ${pick(['manual', 'semi-automatic', 'automatic', 'super-automatic'])} machine?`,
    `machine that can make both espresso and ${pick(['pour-over', 'filter coffee', 'americanos', 'tea'])}`,
    `best espresso machine for a ${pick(['college student', 'young professional', 'retired couple', 'family'])}`,
    `I host dinner parties — which machine is best for making drinks for ${pick(['4', '6', '8', '10'])} guests?`,
  ];
  return { query: pick(templates), category: 'use-case' };
}

function recipeDrink() {
  const recipe = pick(RECIPES);
  const templates = [
    `how to make ${recipe} at home`,
    `${recipe} recipe with an espresso machine`,
    `what's the best way to make a ${recipe}?`,
    `teach me how to make a perfect ${recipe}`,
    `I want to learn to make ${recipe} like a cafe`,
    `tips for making ${pick(['better', 'perfect', 'cafe-quality', 'amazing'])} ${recipe}`,
    `which Arco machine is best for making ${recipe}?`,
    `${recipe} — step by step guide`,
    `what grind size for ${recipe}?`,
    `milk steaming tips for ${pick(['latte art', 'cappuccino', 'flat white', 'microfoam'])}`,
    `best coffee drinks for ${pick(SEASONS)}`,
    `easy coffee drinks I can make at home`,
    `iced espresso drinks for hot days`,
    `how to make coffee cocktails at home`,
    `what's the difference between a ${pick(RECIPES)} and a ${pick(RECIPES)}?`,
  ];
  return { query: pick(templates), category: 'recipe-drink' };
}

function technique() {
  const templates = [
    `how to dial in espresso${maybe(' in under 10 minutes')}`,
    `milk steaming and frothing ${pick(['tips', 'guide', 'tutorial', 'technique'])}`,
    `how to do latte art${maybe(' for beginners')}`,
    `how to ${pick(['tamp', 'distribute', 'dose'])} espresso properly`,
    `what does ${pick(['pre-infusion', 'pressure profiling', 'flow control', 'temperature surfing'])} do?`,
    `how to clean ${pick(['an espresso machine', 'a group head', 'a steam wand', 'a grinder'])}`,
    `how to descale an espresso machine${maybe(' step by step')}`,
    `what's the ideal ${pick(['water temperature', 'brew pressure', 'extraction time', 'grind size', 'dose'])} for espresso?`,
    `how to calibrate a burr grinder`,
    `tips for ${pick(['consistent', 'better', 'more flavorful', 'balanced'])} espresso shots`,
    `why does ${pick(['water chemistry', 'bean freshness', 'grind consistency', 'puck preparation'])} matter?`,
    `how to store coffee beans properly`,
    `${pick(['WDT', 'RDT', 'backflushing', 'portafilter prep'])} — what is it and why does it matter?`,
    `how to use a bottomless portafilter`,
    `understanding extraction yield and TDS`,
    `how to reduce channeling in espresso`,
    `what's the ${pick(['correct', 'best', 'optimal', 'recommended'])} ${pick(['ratio', 'grind size', 'temperature', 'pressure', 'dose', 'yield'])} for ${pick(RECIPES)}?`,
    `how to ${pick(['improve', 'fix', 'perfect', 'master'])} my ${pick(['espresso', 'milk foam', 'latte art', 'pour-over', 'crema'])}`,
    `guide to ${pick(['water filtration', 'water chemistry', 'third wave water', 'mineral content'])} for espresso`,
    `${pick(['beginner', 'intermediate', 'advanced'])} guide to ${pick(['espresso extraction', 'milk texturing', 'grinder calibration', 'puck preparation', 'temperature management'])}`,
    `how often should I ${pick(['clean', 'descale', 'backflush', 'replace burrs on', 'service'])} my ${pick(['espresso machine', 'grinder', 'steam wand', 'group head'])}?`,
    `difference between ${pick(['9 bar and 6 bar extraction', 'blooming and pre-infusion', 'flat and conical burrs', 'pressurized and non-pressurized baskets', 'single and double shots'])}`,
    `how to ${pick(['weigh', 'time', 'measure', 'evaluate', 'judge'])} an espresso ${pick(['shot', 'extraction', 'pull'])}`,
    `${pick(['Turkish', 'Italian', 'Scandinavian', 'Japanese', 'Australian'])} approach to ${pick(['espresso', 'coffee brewing', 'milk drinks'])}`,
    `what's the role of ${pick(['crema', 'pressure', 'grind size', 'water temperature', 'brew time'])} in espresso quality?`,
    `how to switch between ${pick(['espresso and pour-over', 'light and dark roasts', 'single origin and blends'])} on the same grinder`,
  ];
  return { query: pick(templates), category: 'technique' };
}

function troubleshooting() {
  const problem = pick(PROBLEMS);
  const templates = [
    problem,
    `${problem} — what am I doing wrong?`,
    `help! ${problem}`,
    `why does ${problem.replace(/^my /, 'my ')}?`,
    `how to fix: ${problem}`,
    `${problem} with ${maybe('my ')}${pick(MACHINES).name}`,
    `troubleshooting ${pick(['sour espresso', 'bitter coffee', 'weak crema', 'channeling', 'inconsistent shots', 'temperature issues'])}`,
    `common mistakes when ${pick(['making espresso', 'steaming milk', 'using a new grinder', 'dialing in', 'cleaning an espresso machine'])}`,
  ];
  return { query: pick(templates), category: 'troubleshooting' };
}

function exploration() {
  const templates = [
    `what do you recommend for someone new to espresso?`,
    `what's the Arco product lineup?`,
    `tell me about your espresso machines`,
    `what grinders do you offer?`,
    `what makes Arco different from other brands?`,
    `${pick(OPENERS)} getting into espresso at home`,
    `I'm curious about home espresso — where do I start?`,
    `what should I know before buying my first espresso machine?`,
    `overview of Arco's product range`,
    `what's new at Arco?`,
    `your most popular products`,
    `bestselling espresso machine`,
    `recommendations for a ${pick(EXPERIENCE_LEVELS)}`,
    `I love coffee but don't know anything about espresso machines`,
    `help me figure out what kind of coffee person I am`,
    `what's the Arco story?`,
    `why should I choose Arco over ${pick(['Breville', 'De\'Longhi', 'Gaggia', 'Rancilio', 'other brands'])}?`,
    `coffee culture in ${pick(CITIES)}`,
    `best cafes in ${pick(CITIES)} for espresso lovers`,
    `what's the difference between ${pick(['single origin and blend', 'light and dark roast', 'arabica and robusta', 'washed and natural process'])} coffee?`,
    `walk me through the Arco ${pick(['product', 'machine', 'grinder', 'accessory'])} lineup`,
    `what ${pick(['type', 'kind', 'style'])} of espresso machine is right for me?`,
    `convince me to buy an Arco machine${maybe(' over a cheaper brand')}`,
    `what's ${pick(['trending', 'popular', 'hot'])} in the espresso world right now?`,
    `history of ${pick(['espresso', 'the E61 group head', 'Italian coffee culture', 'flat white', 'latte art'])}`,
    `${pick(['fun facts', 'surprising things', 'what most people don\'t know'])} about ${pick(['espresso', 'coffee', 'grinders', 'espresso machines'])}`,
    `what ${pick(['water', 'beans', 'milk', 'accessories', 'tools'])} do I need for great espresso?`,
    `how is Arco ${pick(['different', 'better', 'unique'])} compared to ${pick(['other brands', 'the competition', 'bigger companies'])}?`,
    `do you offer ${pick(['financing', 'warranty', 'repairs', 'support', 'classes', 'tutorials'])}?`,
    `Arco ${pick(['sustainability', 'quality', 'warranty', 'design philosophy', 'manufacturing'])} — tell me more`,
    `I want to understand ${pick(['espresso', 'coffee brewing', 'grinders', 'the Arco brand'])} better`,
  ];
  return { query: pick(templates), category: 'exploration' };
}

function personaDriven() {
  const persona = pick(PERSONAS);
  const scenarios = [
    `I just moved into my first apartment and want a coffee setup`,
    `I'm a new parent and need quick coffee in the morning`,
    `I work from home and want to upgrade my coffee game`,
    `I'm retiring soon and want to learn espresso as a hobby`,
    `${persona.context} — what do you recommend?`,
    `${persona.context}. What machine should I get?`,
    `I'm ${pick(EXPERIENCE_LEVELS)} and ${persona.context.toLowerCase()}`,
    `My partner and I disagree — I want espresso, they want ${pick(['filter coffee', 'lattes', 'cappuccinos', 'automatic', 'simple'])}`,
    `I just got back from Italy and want to recreate that espresso at home`,
    `I'm a barista and want a serious setup for home`,
    `I've been using a French press for years — should I switch to espresso?`,
    `my ${pick(['Keurig', 'Nespresso', 'drip machine', 'Moka pot'])} just broke — time to upgrade`,
    `I want to impress my ${pick(['friends', 'family', 'dinner guests', 'in-laws'])} with homemade coffee`,
    `I'm building a ${pick(['coffee corner', 'home cafe', 'coffee station'])} — what do I need?`,
    `I drink ${pick(['3', '4', '5', '6'])} coffees a day — what's most economical?`,
    `I'm ${pick(['on a tight budget', 'willing to invest', 'looking for the best regardless of price'])} — guide me`,
    `I'm a ${pick(['teacher', 'doctor', 'engineer', 'designer', 'writer', 'chef', 'student', 'retiree'])} who ${pick(['loves coffee', 'wants to get into espresso', 'needs better coffee at work', 'just discovered specialty coffee'])}`,
    `my ${pick(['spouse', 'roommate', 'kid', 'friend'])} and I want to start a home coffee ${pick(['setup', 'station', 'corner', 'bar'])}`,
    `I currently use a ${pick(['French press', 'AeroPress', 'Moka pot', 'drip coffee maker', 'pour-over', 'Chemex'])} and want to try espresso`,
    `I'm hosting a ${pick(['birthday party', 'holiday gathering', 'brunch', 'book club', 'game night'])} and want to serve great coffee`,
    `${persona.context}. My budget is ${pick(BUDGETS)}`,
  ];
  return { query: pick(scenarios), category: 'persona-driven' };
}

// --- Category targets ---

const GENERATORS = [
  { fn: productSpecific, target: 150 },
  { fn: comparison, target: 120 },
  { fn: buyingGuide, target: 130 },
  { fn: useCase, target: 130 },
  { fn: recipeDrink, target: 100 },
  { fn: technique, target: 100 },
  { fn: troubleshooting, target: 80 },
  { fn: exploration, target: 100 },
  { fn: personaDriven, target: 90 },
];

// --- Main ---

function generate() {
  const prompts = [];
  const seen = new Set();
  let id = 1;

  for (const { fn, target } of GENERATORS) {
    let attempts = 0;
    let generated = 0;
    while (generated < target && attempts < target * 10) {
      attempts++;
      const { query, category } = fn();
      const normalized = query.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        prompts.push({ id, query, category });
        id++;
        generated++;
      }
    }
    if (generated < target) {
      console.warn(`[generate-prompts] Only generated ${generated}/${target} for category: ${fn.name}`);
    }
  }

  return prompts;
}

async function main() {
  console.log('[generate-prompts] Generating test prompts...');
  const prompts = generate();
  const outPath = join(__dirname, 'prompts.json');
  await writeFile(outPath, JSON.stringify(prompts, null, 2));
  console.log(`[generate-prompts] Wrote ${prompts.length} prompts to ${outPath}`);

  // Print category distribution
  const cats = {};
  for (const p of prompts) {
    cats[p.category] = (cats[p.category] || 0) + 1;
  }
  console.log('\nCategory distribution:');
  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
