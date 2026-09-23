#!/usr/bin/env python3
"""Derive a card-column 1966 MAD reconstruction from the recovered 1965b driver.

The numbered recovered listing under references/ is never modified. This file
is a transparent patch recipe for the native reconstruction, not a claim that
the missing 1966 listing looked like this.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "references/1965b-CTSS-reconstruction/eliza/src/ELIZA"
HERE = Path(__file__).resolve().parent
rows = []


def add(label, body, control=" "):
    if len(label) > 10 or len(body) > 67:
        raise ValueError((label, len(body), body))
    rows.append((label, control, body))


def block(source):
    for row in source.strip("\n").splitlines():
        label, body = row.split("|", 1)
        add("" if label == "1" else label, body,
            "1" if label == "1" else " ")


def original(lo, hi):
    for line in (BASE / "eliza.mad").read_text().splitlines():
        try:
            number = int(line[80:].strip())
        except ValueError:
            continue
        if not lo <= number < hi:
            continue
        label, body = line[:10].strip(), line[12:79].rstrip()
        body = body.replace("KEY(32)", "KEY(128)")
        body = body.replace("TOP.(INPUT),5", "TOP.(INPUT),7")
        body = body.replace("I .G. 32", "I .G. 128")
        body = body.replace("I  .G. 32", "I  .G. 128")
        if "DIMENSION KEY(128),MYTRAN(4)" in body:
            body = "DIMENSION KEY(128),MYTRAN(4),KSIT(100),KSWD(100)"
        add(label, body, line[11])


original(0, 490)

block("""
|            KEYWRD=0
|            NK=0
|            HIGEST=0
|            LIMIT=LIMIT+1
|            W'R LIMIT .E. 5, LIMIT=1
|            W'R LISTMT.(INPUT) .E. 0, T'O ENDPLA
|            W'R TOP.(INPUT) .E. $+$
|                CHANGE.(KEY,MYTRAN)
|                T'O START
|            E'L
|            W'R TOP.(INPUT) .E. $*$, T'O NEWLST
|            S=SEQRDR.(INPUT)
NOTYET|     W'R S .L. 0
|                SEQLR.(S,F)
|                T'O NOTYET
|            O'E
|                WORD=SEQLR.(S,F)
|                W'R WORD .E. $.$ .OR. WORD .E. $,$ .OR.
1|                WORD .E. $BUT$
|                    W'R NK .E. 0
|                        NULSTL.(INPUT,LSPNTR.(S),JUNK)
|                        MTLIST.(JUNK)
|                        T'O NOTYET
|                    O'E
|                        NULSTR.(INPUT,LSPNTR.(S),JUNK)
|                        MTLIST.(JUNK)
|                        T'O ENDTXT
|                    E'L
|                E'L
|                W'R F .G. 0, T'O ENDTXT
|                I=HASH.(WORD,7)
|                SCANER=SEQRDR.(KEY(I))
|                SF=0
SEARCH|          CAND=SEQLR.(SCANER,SF)
|                W'R SF .G. 0, T'O NOTYET
|                W'R TOP.(CAND) .NE. WORD, T'O SEARCH
|                SS=S
|                READER=TESTS.(CAND,SS)
|                W'R READER .E. 0, T'O SEARCH
|                S=SS
|                W'R LSTNAM.(CAND) .NE. 0
|                    DL=LSTNAM.(CAND)
SEQ|                W'R S .L. 0
|                        SEQLR.(S,F)
|                        T'O SEQ
|                    O'E
|                        NEWTOP.(DL,LSPNTR.(S))
|                    E'L
|                E'L
|                NEXT=SEQLR.(READER,FR)
|                W'R FR .G. 0, T'O NOTYET
|                RANK=0
|                W'R FR .L. 0
|                    RANK=NEXT
|                    NEXT=SEQLR.(READER,FR)
|                E'L
|                W'R NK .GE. 100, T'O ENDTXT
|                NK=NK+1
|                W'R NK .E. 1 .OR. RANK .LE. HIGEST
|                    KSIT(NK)=READER
|                    KSWD(NK)=WORD
|                    W'R NK .E. 1, HIGEST=RANK
|                    T'O NOTYET
|                E'L
|                T'H SHIFTK, FOR K=NK,-1,K .LE. 1
SHIFTK|          KSIT(K)=KSIT(K-1)
|                KSWD(K)=KSWD(K-1)
|                KSIT(1)=READER
|                KSWD(1)=WORD
|                HIGEST=RANK
|                T'O NOTYET
|            E'L
ENDTXT|     W'R NK .E. 0
|                W'R LIMIT .E. 4 .AND. LISTMT.(MYLIST) .NE. 0
|                    OUT=POPTOP.(MYLIST)
|                    TXTPRT.(OUT,0)
|                    IRALST.(OUT)
|                    T'O START
|                E'L
|                T'O NONEKY
|            E'L
NEXTK|       W'R NK .E. 0, T'O NONEKY
|            IT=KSIT(1)
|            KEYWRD=KSWD(1)
|            T'H SHDOWN, FOR K=1,1,K .GE. NK
SHDOWN|      KSIT(K)=KSIT(K+1)
|            KSWD(K)=KSWD(K+1)
|            NK=NK-1
|            W'R KEYWRD .E. MEMORY
|                I=HASH.(BOT.(INPUT),2)+1
|                NEWBOT.(REGEL.(MYTRAN(I),INPUT,LIST.(MINE)),
1|                MYLIST)
|            E'L
|            SEQLL.(IT,FR)
|            T'O MATCH
NONEKY|      ES=BOT.(TOP.(KEY(128)))
|            T'O TRY
MATCH|       ES=SEQLR.(IT,FR)
|            W'R FR .G. 0, T'O NEXTK
|            W'R TOP.(ES) .E. $=$, T'O LINK
TRY|         W'R YMATCH.(TOP.(ES),INPUT,MTLIST.(TEST)) .E. 0
1|            ,T'O MATCH
|            ESRDR=SEQRDR.(ES)
|            SEQLR.(ESRDR,ESF)
|            POINT=SEQLR.(ESRDR,ESF)
|            POINTR=LSPNTR.(ESRDR)
|            W'R ESF .E. 0
|                NEWBOT.(1,POINTR)
|                TRANS=POINT
|                T'O HIT
|            E'L
|            T'H FNDHIT,FOR I=0,1,I .G. POINT
FNDHIT|     TRANS=SEQLR.(ESRDR,ESF)
|            W'R ESF .G. 0
|                SEQLR.(ESRDR,ESF)
|                SEQLR.(ESRDR,ESF)
|                TRANS=SEQLR.(ESRDR,ESF)
|                SUBST.(1,POINTR)
|                T'O HIT
|            E'L
|            SUBST.(POINT+1,POINTR)
|            T'O HIT
HIT|         W'R TOP.(TRANS) .E. $NEWKEY$, T'O NEXTK
|            W'R TOP.(TRANS) .E. $=$
|                ES=TRANS
|                T'O LINK
|            E'L
|            W'R TOP.(TRANS) .E. $PRE$
|                PR=SEQRDR.(TRANS)
|                SEQLR.(PR,F)
|                TMPLET=SEQLR.(PR,F)
|                PRLINK=SEQLR.(PR,F)
|                BUILT=ASSMBL.(TMPLET,TEST,MTLIST.(OUTPUT))
|                W'R BUILT .E. 0, T'O NEXTK
|                LSSCPY.(BUILT,MTLIST.(INPUT))
|                ES=PRLINK
|                T'O LINK
|            E'L
|            TXTPRT.(ASSMBL.(TRANS,TEST,MTLIST.(OUTPUT)),0)
|            T'O START
LINK|        S=SEQRDR.(ES)
|            SEQLR.(S,F)
|            WORD=SEQLR.(S,F)
|            I=HASH.(WORD,7)
|            SCANER=SEQRDR.(KEY(I))
SCAN|        ITS=SEQLR.(SCANER,F)
|            W'R F .G. 0, T'O NEXTK
|            W'R WORD .NE. TOP.(ITS), T'O SCAN
|            S=SEQRDR.(ITS)
SCANI|      ES=SEQLR.(S,F)
|            W'R F .NE.0, T'O SCANI
|            IT=S
|            T'O TRY
""")

original(1760, 3000)

# The editor in 1965b independently hashes keyword names and walks the full
# directory. It must follow the 1966 width too.
editor = (BASE / "change.mad").read_text()
editor = editor.replace("I  .G. 32", "I  .G. 128")
editor = editor.replace("THEME,5", "THEME,7")
(HERE / "change-1966.mad").write_text(editor)

# The pinned reconstruction already has a clean CTSS-ready transcription of
# the published script; this disk calls its paired script number 100.
(HERE / "tape.100").write_bytes((BASE / "tape.200").read_bytes())

(HERE / "eliza-1966.mad").write_text("".join(
    f"{label:<10} {control}{body:<67} {number:06d}\n"
    for number, (label, control, body) in enumerate(rows, 10)
))
print(f"Wrote {len(rows)} MAD cards")
