"""A module for the indent fixture: black's layout, each construct the rules place."""

from __future__ import annotations

import os
from collections import (
    OrderedDict,
    defaultdict,
)
from typing import Any


def plain(a, b):
    """One line."""
    return a + b


def long_signature(
    first_argument: int,
    second_argument: str = "défaut",
    *rest: Any,
    **options: Any,
) -> dict[str, Any]:
    """A docstring
    of two lines, its second kept as it is.
    """
    result = {
        "first": first_argument,
        "second": [
            second_argument,
            second_argument.upper(),
        ],
        "rest": rest,
    }
    if options:
        result.update(options)
    elif rest:
        pass
    else:
        result["none"] = None
    return result


@decorator
@decorator_with_arguments(
    "one",
    two=2,
)
class Holder(Base, metaclass=Meta):
    """A class."""

    attribute: int = 0

    def __init__(self, value):
        self.value = value
        # a comment at the block's end

    # a comment between methods
    def method(self):
        for item in self.value:
            if item:
                continue
            while item > 0:
                item -= 1
                if item == 3:
                    break
            else:
                pass
        else:
            return None

        def nested():
            return [
                x * 2
                for x in self.value
                if x and x > the_threshold_of_this_holder_value(x)
            ]

        return nested

    @property
    def values(self):
        return (
            self.value_of_the_first_kind
            + self.value_of_the_second_kind
            + self.value_of_a_third
        )


async def fetch(session, url):
    async with session.get(url) as response:
        async for chunk in response.content:
            yield chunk


def handle():
    try:
        os.remove("path")
    except FileNotFoundError:
        pass
    except (PermissionError, IsADirectoryError) as error:
        raise RuntimeError(  # a comment after the bracket
            "no",
        ) from error
    else:
        print("removed")
    finally:
        print("done")


def groups():
    try:
        pass
    except* ValueError:
        pass


def paths(a, b):
    with (
        open(a) as first,
        open(b) as second,
    ):
        return first.read() + second.read()


def shapes(point):
    match point:
        case Point(
            x=0,
            y=0,
        ):
            return "origin"
        case [first, *others]:
            return first
        case {"key": value}:
            return value
        case _:
            return None


table = defaultdict(
    lambda: OrderedDict(
        a=1,
        b=2,
    )
)
numbers = {x: x**2 for x in range(10)}
text = """
not indented
    by the rules
"""
squares = {
    square_of(number) for number in range(10) if number % 3 == 0 and is_wanted(number)
}
value = table["a key long enough to split the line"][
    "an inner key long enough to split it too"
]
if numbers and squares:
    print(
        "λ",
        text,
    )
