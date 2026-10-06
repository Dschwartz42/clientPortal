from pydantic import BaseModel


class Paginated[T](BaseModel):
    items: list[T]
    total: int
    page: int
    page_size: int
