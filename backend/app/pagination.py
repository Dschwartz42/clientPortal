from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query

MAX_PAGE_SIZE = 100
MAX_PAGE = 1_000_000


@dataclass
class Page:
    page: int
    page_size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def page_params(
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1, page_size: Annotated[int, Query(ge=1)] = 25
) -> Page:
    return Page(page=page, page_size=min(page_size, MAX_PAGE_SIZE))


PageDep = Annotated[Page, Depends(page_params)]
