from decimal import Decimal

from app.services.analytics import money, net_revenue, pct_change


def test_net_revenue_is_charges_minus_refunds_minus_credits():
    items = [
        ("charge", Decimal("1000.00")),
        ("charge", Decimal("500.00")),
        ("refund", Decimal("200.00")),
        ("credit", Decimal("50.00")),
    ]
    assert net_revenue(items) == Decimal("1250.00")


def test_net_revenue_of_nothing_is_zero():
    assert net_revenue([]) == Decimal("0.00")


def test_pct_change():
    assert pct_change(Decimal("1250.00"), Decimal("700.00")) == 78.57
    assert pct_change(Decimal("50.00"), Decimal("100.00")) == -50.0


def test_pct_change_is_none_when_there_is_no_previous_revenue():
    assert pct_change(Decimal("100.00"), Decimal("0.00")) is None


def test_money_always_has_two_decimal_places():
    assert str(money(None)) == "0.00"
    assert str(money(5)) == "5.00"
