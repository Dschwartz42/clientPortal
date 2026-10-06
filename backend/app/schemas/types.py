from typing import Annotated

from pydantic import AfterValidator


def reject_nul(value: str) -> str:
    # PostgreSQL text cannot hold NUL; reject it at the edge instead of failing in the driver.
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


NoNulStr = Annotated[str, AfterValidator(reject_nul)]
