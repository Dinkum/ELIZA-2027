/**
 * SLIP — Symmetric LIst Processor.
 *
 * Weizenbaum's own list-processing package, which ELIZA is written against.
 * Transliterated from the SLIP sources recovered alongside ELIZA, in
 * references/1965b-CTSS-reconstruction/eliza/src/SLIP/. Routine names, entry
 * points, labels and return conventions are kept; the 7094's two-word cells and
 * 32K core are not. Where the original manipulates LNKL/LNKR/ID bit fields of a
 * machine word, this holds the same four quantities as object properties.
 *
 * The cell is the whole of SLIP. A cell carries:
 *
 *   id      0 datum, 1 datum is the name of a sublist, 2 list header, 3 reader
 *   neg     the sign bit of the indicator word, set by MRKNEG. A cell marked
 *           negative is continued by the cell after it: SLIP packs six
 *           characters to a cell, so INVENTED is the cells INVENT and ED.
 *   datum   a BCD word (string), an integer, or a list header
 *   left    LNKL
 *   right   LNKR
 *
 * A list is a header cell linked circularly to its elements. A reader is a
 * position in that ring; SEQLR and SEQLL step it right and left and report what
 * kind of cell they landed on through FLAG = ID - 1, so
 *
 *   FLAG < 0   an ordinary datum
 *   FLAG = 0   the datum names a sublist
 *   FLAG > 0   the reader has come back round to the header
 *
 * Return conventions are SLIP's, which are not modern ones: LISTMT returns 0
 * for an empty list, NAMTST returns 0 when the datum IS a list name, and
 * LSTEQL returns 0 when the two lists are equal.
 */

export const ID_DATUM = 0;
export const ID_NAME = 1;
export const ID_HEADER = 2;
export const ID_READER = 3;

/** Characters per cell. SLIP packs six BCD characters into one 36-bit word. */
export const CELL_CHARACTERS = 6;

/**
 * NUCELL. hands out cells in order from available space, so a cell's address
 * is where SLIP happened to put it. ELIZA depends on that in one place: when
 * the last cell of the input holds the name of a sublist, HASH is handed the
 * sublist's address. The addresses here are not the 7094's, so that one choice
 * is deterministic but is not the choice the original would have made.
 */
let nucell = 0;

class Cell {
  constructor(id, datum) {
    nucell += 2; // a SLIP cell is two words
    this.addr = nucell;
    this.id = id;
    this.datum = datum;
    this.left = this;
    this.right = this;
    this.neg = false;
  }
}

/**
 * A list header. LNKL and LNKR of the header's second word hold the
 * description list and the reference count (see LSTNAM and LCNTR).
 */
class Header extends Cell {
  constructor() {
    super(ID_HEADER, null);
    this.datum = this;
    this.dlist = 0;
    this.lcntr = 0;
  }
}

/**
 * FLAG and similar arguments are passed by reference in MAD. A Ref stands in
 * for that, so a transliterated call reads the way the original does.
 */
export class Ref {
  constructor(v = 0) {
    this.v = v;
  }
}

export const ref = (v = 0) => new Ref(v);

// --- creation and emptiness ----------------------------------------------

/**
 * LIST. — make a new, empty list.
 *
 * SLIP gives a named list a reference count of 1, so the IRALST that balances
 * it frees the list. LIST.(9) is the anonymous form and skips that, leaving the
 * count at 0 so that whatever NEWBOTs the list is the first thing to hold it.
 */
export function LIST() {
  const lst = new Header();
  lst.lcntr = 1;
  return lst;
}

/** LIST.(9) — an anonymous list, with no reference of its own. */
export function LIST9() {
  return new Header();
}

/** LISTMT. — 0 if the list is empty, 1 if it holds anything. */
export function LISTMT(lst) {
  return lst.right === lst ? 0 : 1;
}

/** MTLIST. — empty a list, leaving the header. */
export function MTLIST(lst) {
  lst.left = lst;
  lst.right = lst;
  return lst;
}

/** LCNTR. — the list's reference count. */
export function LCNTR(lst) {
  return lst.lcntr;
}

/** LSTNAM. — the list's description list, or 0. */
export function LSTNAM(lst) {
  return lst.dlist;
}

/** MAKEDL. — give a list a description list. */
export function MAKEDL(dlst, lst) {
  lst.dlist = dlst;
  if (dlst !== 0) dlst.lcntr += 1;
  return lst;
}

/** NODLST. — take a list's description list away. */
export function NODLST(lst) {
  const it = LSTNAM(lst);
  if (it === 0) return it;
  IRALST(it);
  lst.dlist = 0;
  return it;
}

/**
 * IRALST. — drop a reference to a list; empty it when the last one goes.
 * SLIP returns the cells to available space here. There is no available space
 * to return them to, so this only keeps the count and the emptying.
 */
export function IRALST(lst) {
  lst.lcntr -= 1;
  if (lst.lcntr !== 0) return lst;
  MTLIST(lst);
  return lst;
}

// --- cells ---------------------------------------------------------------

/** NAMTST. — 0 when the datum is the name of a list, 1 when it is not. */
export function NAMTST(candat) {
  return candat instanceof Header ? 0 : 1;
}

/** Link a new cell in to the left of `addr`. */
function link(addr, cell) {
  const ll = addr.left;
  ll.right = cell;
  cell.left = ll;
  cell.right = addr;
  addr.left = cell;
  return cell;
}

function makeCell(obj) {
  if (NAMTST(obj) === 0) {
    const cell = new Cell(ID_NAME, obj);
    obj.lcntr += 1;
    return cell;
  }
  return new Cell(ID_DATUM, obj);
}

/** NEWBOT. — put a datum on the bottom of a list, or after a given cell. */
export function NEWBOT(obj, lst) {
  return link(lst, makeCell(obj));
}

/**
 * NEWTOP. — put a datum on the top of a list.
 * SLIP takes the cell to the right of `lst` and inserts before it, so passing a
 * plain cell rather than a header inserts immediately after that cell. TESTS
 * relies on this when it splices a word substitution into the input.
 */
export function NEWTOP(obj, lst) {
  return link(lst.right, makeCell(obj));
}

/**
 * REMOVE. — unlink a cell and return its datum.
 * The removed cell keeps its own links. On the 7094 the cell went back to
 * available space and its words stayed readable until something else claimed
 * them, and TESTS reads through a cell it has just removed.
 */
export function REMOVE(addr) {
  if (addr.id === ID_HEADER) return 0; // HEADER REMOVE
  const it = addr.datum;
  const { left, right } = addr;
  left.right = right;
  right.left = left;
  return it;
}

/** POPTOP. / POPBOT. */
export const POPTOP = (lst) => REMOVE(lst.right);
export const POPBOT = (lst) => REMOVE(lst.left);

/** TOP. / BOT. */
export const TOP = (lst) => lst.right.datum;
export const BOT = (lst) => lst.left.datum;

/** SUBST. — replace a cell's datum, returning what was there. */
export function SUBST(datum, addr) {
  const present = addr.datum;
  addr.datum = datum;
  addr.id = NAMTST(datum) === 0 ? ID_NAME : ID_DATUM;
  if (addr.id === ID_NAME) datum.lcntr += 1;
  return present;
}

/** MRKNEG. / MRKPOS. — set and clear the sign of a cell's indicator word. */
export function MRKNEG(cell) {
  cell.neg = true;
  return cell;
}

export function MRKPOS(cell) {
  cell.neg = false;
  return cell;
}

/** LNKBOT. — continue the word already at the bottom of the list. */
export function LNKBOT(obj, lst) {
  if (LISTMT(lst) !== 0) MRKNEG(lst.left);
  return NEWBOT(obj, lst);
}

// --- readers -------------------------------------------------------------

/**
 * A reader is a COPY of the indicator word of the cell it last landed on, not a
 * pointer to that cell. This matters. ELIZA splits the input list while a
 * reader is sitting on the cell it splits at, and goes on reading afterwards:
 *
 *     NULSTL.(INPUT,LSPNTR.(S),JUNK)                                    000680
 *     MTLIST.(JUNK)                                                     000690
 *     T'O NOTYET                                                        000700
 *
 * The cell the reader is on has just had its right link bent round to the
 * JUNK header, but the reader kept the link it read, so it carries on into
 * what is left of the input. A reader holding a live reference would instead
 * walk into JUNK and see the end of the list, and the first clause of every
 * sentence would swallow the rest.
 *
 * LSPNTR is written the long way round in SLIP for the same reason: it steps
 * out to the cell on the reader's right and comes back through memory, so it
 * always answers with the cell that is there now.
 */
class SeqReader {
  constructor(cell) {
    this.id = cell.id;
    this.left = cell.left;
    this.right = cell.right;
    this.neg = cell.neg;
  }
}

function land(reader, cell, flag) {
  reader.id = cell.id;
  reader.left = cell.left;
  reader.right = cell.right;
  reader.neg = cell.neg;
  flag.v = cell.id - 1;
  return cell.datum;
}

/** SEQRDR. — a reader at the head of a list. */
export function SEQRDR(lst) {
  return new SeqReader(lst);
}

/** SEQLR. — step right. Sets FLAG to ID - 1 and returns the datum. */
export function SEQLR(reader, flag) {
  return land(reader, reader.right, flag);
}

/** SEQLL. — step left. */
export function SEQLL(reader, flag) {
  return land(reader, reader.left, flag);
}

/** W'R S .L. 0 — is the cell the reader last read continued by the next one? */
export const RDRNEG = (reader) => reader.neg;

/** LSPNTR. / SEQPTR. — LNKL.(CONT.(LNKR.(S))): the cell now to the reader's left. */
export const LSPNTR = (reader) => reader.right.left;

/** A reader is a value in MAD, so STORE=S in TESTS takes a copy. */
export const RDRCPY = (reader) => Object.assign(Object.create(SeqReader.prototype), reader);

// --- whole-list operations ------------------------------------------------

/**
 * LSSCPY. — copy a list structure into `copy`.
 * Sublists reached more than once are copied once and shared, which is what
 * SLIP's NEWVAL/ITSVAL stack is doing in the original.
 */
export function LSSCPY(orgnl, copy, seen = new Map()) {
  seen.set(orgnl, copy);
  if (LSTNAM(orgnl) !== 0) {
    const dl = LSTNAM(orgnl);
    const already = seen.get(dl);
    MAKEDL(already ?? LSSCPY(dl, LIST9(), seen), copy);
  }

  const reader = SEQRDR(orgnl);
  const flag = ref();
  for (;;) {
    const datum = SEQLR(reader, flag);
    if (flag.v > 0) return copy;
    if (flag.v < 0) {
      const cell = NEWBOT(datum, copy);
      if (RDRNEG(reader)) MRKNEG(cell);
    } else {
      const already = seen.get(datum);
      const sub = already ?? LSSCPY(datum, LIST9(), seen);
      const cell = NEWBOT(sub, copy);
      if (RDRNEG(reader)) MRKNEG(cell);
    }
  }
}

/** LSTEQL. — 0 when two list structures are equal, -1 when they are not. */
export function LSTEQL(one, other) {
  if (one === other) return 0;
  if (NAMTST(one) !== 0 || NAMTST(other) !== 0) return one === other ? 0 : -1;

  const sa = SEQRDR(one);
  const sb = SEQRDR(other);
  const fa = ref();
  const fb = ref();
  for (;;) {
    const da = SEQLR(sa, fa);
    const db = SEQLR(sb, fb);
    if (fa.v !== fb.v) return -1;
    if (fa.v < 0) {
      if (da !== db) return -1;
    } else if (fa.v === 0) {
      if (LSTEQL(da, db) !== 0) return -1;
    } else {
      return 0;
    }
  }
}

/** CONLST. — attach RIGHT to the bottom of LEFT, emptying RIGHT. */
export function CONLST(left, right) {
  if (LISTMT(right) === 0) return left;
  const lbot = left.left;
  const rtop = right.right;
  const rbot = right.left;
  lbot.right = rtop;
  rtop.left = lbot;
  rbot.right = left;
  left.left = rbot;
  MTLIST(right);
  return left;
}

/** INLSTL. — move a list's cells in to the left of a cell, emptying it. */
export function INLSTL(m, a) {
  if (LISTMT(m) === 0) return m;
  const itop = m.right;
  const ibot = m.left;
  MTLIST(m);
  const ipre = a.left;
  ipre.right = itop;
  itop.left = ipre;
  ibot.right = a;
  a.left = ibot;
  return m;
}

/**
 * NULSTL. / NULSTR. — split a list at a cell, moving one side into NEWLST.
 * NULSTL takes everything to the left of the cell, including it; NULSTR takes
 * everything to the right, including it.
 */
export function NULSTL(list, cell, newlst) {
  return split(list, cell, newlst, 1);
}

export function NULSTR(list, cell, newlst) {
  return split(list, cell, newlst, 2);
}

function split(list, cell, newlst, switch_) {
  if (LISTMT(list) === 0) return newlst;

  if (cell.id === ID_HEADER) {
    CONLST(newlst, list);
    return newlst;
  }

  const top = list.right;
  const bot = list.left;

  if (switch_ === 1) {
    const nutop = cell.right;
    newlst.left = cell;
    newlst.right = top;
    top.left = newlst;
    cell.right = newlst;
    list.right = nutop;
    nutop.left = list;
  } else {
    const nubot = cell.left;
    newlst.left = bot;
    newlst.right = cell;
    cell.left = newlst;
    bot.right = newlst;
    list.left = nubot;
    nubot.right = list;
  }
  return newlst;
}
