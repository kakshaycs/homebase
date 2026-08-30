/* Bundled offline — no API call, no permission, works on a plane. */

export const QUOTES = [
  ['The best way to predict the future is to create it.', 'Peter Drucker'],
  ['Simplicity is the soul of efficiency.', 'Austin Freeman'],
  ['Make it work, make it right, make it fast.', 'Kent Beck'],
  ['Premature optimization is the root of all evil.', 'Donald Knuth'],
  ['Programs must be written for people to read, and only incidentally for machines to execute.', 'Harold Abelson'],
  ['The most damaging phrase in the language is: “we have always done it this way.”', 'Grace Hopper'],
  ['Any fool can write code a computer understands. Good programmers write code humans understand.', 'Martin Fowler'],
  ['Deleted code is debugged code.', 'Jeff Sickel'],
  ['Weeks of coding can save you hours of planning.', 'Anonymous'],
  ['Perfection is achieved when there is nothing left to take away.', 'Antoine de Saint-Exupéry'],
  ['It always seems impossible until it is done.', 'Nelson Mandela'],
  ['Slow is smooth, smooth is fast.', 'Navy SEAL adage'],
  ['Amateurs sit and wait for inspiration. The rest of us just get up and go to work.', 'Stephen King'],
  ['You do not rise to the level of your goals. You fall to the level of your systems.', 'James Clear'],
  ['The secret of getting ahead is getting started.', 'Mark Twain'],
  ['Focus is about saying no.', 'Steve Jobs'],
  ['If you are not embarrassed by the first version, you launched too late.', 'Reid Hoffman'],
  ['Done is better than perfect.', 'Sheryl Sandberg'],
  ['Work expands to fill the time available for its completion.', 'Cyril Parkinson'],
  ['What gets measured gets managed.', 'Peter Drucker'],
  ['The obstacle is the way.', 'Marcus Aurelius'],
  ['You have power over your mind, not outside events. Realize this, and you will find strength.', 'Marcus Aurelius'],
  ['We suffer more often in imagination than in reality.', 'Seneca'],
  ['It is not that we have a short time to live, but that we waste much of it.', 'Seneca'],
  ['First say to yourself what you would be; then do what you have to do.', 'Epictetus'],
  ['Compound interest is the eighth wonder of the world.', 'Attributed to Einstein'],
  ['Risk comes from not knowing what you are doing.', 'Warren Buffett'],
  ['The big money is not in the buying and selling, but in the waiting.', 'Charlie Munger'],
  ['Invert, always invert.', 'Carl Jacobi'],
  ['A goal without a plan is just a wish.', 'Antoine de Saint-Exupéry'],
  ['Everything should be made as simple as possible, but no simpler.', 'Albert Einstein'],
  ['If you cannot explain it simply, you do not understand it well enough.', 'Richard Feynman'],
  ['The first principle is that you must not fool yourself — and you are the easiest person to fool.', 'Richard Feynman'],
  ['Science is what we understand well enough to explain to a computer.', 'Donald Knuth'],
  ['Talk is cheap. Show me the code.', 'Linus Torvalds'],
  ['Given enough eyeballs, all bugs are shallow.', 'Linus Torvalds'],
  ['Controlling complexity is the essence of computer programming.', 'Brian Kernighan'],
  ['Debugging is twice as hard as writing the code in the first place.', 'Brian Kernighan'],
  ['There are two ways of constructing a design: make it so simple there are obviously no deficiencies, or so complicated there are no obvious deficiencies.', 'Tony Hoare'],
  ['Good judgement comes from experience. Experience comes from bad judgement.', 'Rita Mae Brown'],
  ['Discipline equals freedom.', 'Jocko Willink'],
  ['How you do anything is how you do everything.', 'Anonymous'],
  ['Small steps, every day.', 'Anonymous'],
  ['Comparison is the thief of joy.', 'Theodore Roosevelt'],
  ['Fall in love with the process and the results will come.', 'Eric Thomas'],
  ['Energy and persistence conquer all things.', 'Benjamin Franklin'],
  ['Well begun is half done.', 'Aristotle'],
  ['We are what we repeatedly do. Excellence, then, is not an act but a habit.', 'Will Durant'],
  ['The cost of being wrong is less than the cost of doing nothing.', 'Seth Godin'],
  ['Ship it.', 'Anonymous']
];

/** A quote index that stays stable for the whole calendar day. */
export function quoteOfTheDay() {
  const d = new Date();
  const key = d.getFullYear() * 1000 + Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  return key % QUOTES.length;
}

export function randomIndex(exclude = -1) {
  if (QUOTES.length < 2) return 0;
  let i = exclude;
  while (i === exclude) i = Math.floor(Math.random() * QUOTES.length);
  return i;
}

export function quoteAt(i) {
  const [text, author] = QUOTES[((i % QUOTES.length) + QUOTES.length) % QUOTES.length];
  return { text, author };
}
