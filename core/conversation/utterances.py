"""Classify short acknowledgements and continuation utterances."""

from __future__ import annotations

from unicodedata import normalize as unicode_normalize


_NON_TOPIC_MAX_KEY_CHARS = 96

_ACKNOWLEDGEMENT_KEYS = frozenset({
    "ack",
    "acknowledged",
    "affirmative",
    "agreed",
    "allright",
    "alright",
    "confirmed",
    "correct",
    "exactly",
    "fine",
    "goahead",
    "gotit",
    "looksgood",
    "makesense",
    "muchappreciated",
    "noted",
    "ok",
    "okay",
    "received",
    "right",
    "roger",
    "soundsgood",
    "sure",
    "thankyou",
    "thanks",
    "understand",
    "understood",
    "willdo",
    "worksforme",
    "y",
    "yeah",
    "yep",
    "yes",
    "yup",
})

_NEGATIVE_ACKNOWLEDGEMENT_KEYS = frozenset({
    "cancel",
    "donot",
    "dont",
    "negative",
    "nevermind",
    "no",
    "nothanks",
    "nope",
    "not",
    "notnow",
    "notquite",
    "notreally",
    "pleasecancel",
    "pleasestop",
    "reject",
    "stop",
})

_CONTINUATION_KEYS = frozenset({
    "carryon",
    "continue",
    "continueplease",
    "doit",
    "execute",
    "goon",
    "keepgoing",
    "letuscontinue",
    "letscontinue",
    "moveon",
    "next",
    "nextone",
    "nextstep",
    "pickupwhereyouleftoff",
    "pleasecontinue",
    "pleasegoon",
    "pleaseproceed",
    "proceed",
    "resume",
    "resumeplease",
    "rerun",
    "runagain",
    "retry",
    "start",
    "then",
    "tryagain",
})

_POLITENESS_KEYS = frozenset({
    "kindly",
    "please",
    "thankyou",
    "thanks",
})

_NON_TOPIC_COMPONENT_KEYS = tuple(sorted(
    (
        _ACKNOWLEDGEMENT_KEYS
        | _NEGATIVE_ACKNOWLEDGEMENT_KEYS
        | _CONTINUATION_KEYS
        | _POLITENESS_KEYS
    ),
    key=len,
    reverse=True,
))


def canonical_utterance_key(value: str) -> str:
    normalized = unicode_normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def is_non_topic_utterance(text: str) -> bool:
    """Return whether the complete short utterance contains no retrieval topic."""
    key = canonical_utterance_key(text)
    if not key or len(key) > _NON_TOPIC_MAX_KEY_CHARS:
        return False

    reachable = {0}
    for start in range(len(key)):
        if start not in reachable:
            continue
        for component in _NON_TOPIC_COMPONENT_KEYS:
            if key.startswith(component, start):
                reachable.add(start + len(component))
    return len(key) in reachable
