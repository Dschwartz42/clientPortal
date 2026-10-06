import uuid

from app.services.users import check_user_update

ME, OTHER = uuid.uuid4(), uuid.uuid4()


def _check(**overrides):
    args = {
        "actor_id": ME,
        "target_id": OTHER,
        "target_role": "admin",
        "target_is_active": True,
        "new_role": "admin",
        "new_is_active": True,
        "other_active_admins": 0,
    }
    return check_user_update(**{**args, **overrides})


def test_demoting_the_last_admin_is_rejected():
    assert _check(new_role="member")[0] == "last_admin"


def test_deactivating_the_last_admin_is_rejected():
    assert _check(new_is_active=False)[0] == "last_admin"


def test_demoting_an_admin_is_fine_when_another_remains():
    assert _check(new_role="member", other_active_admins=1) is None


def test_changing_a_member_never_trips_the_last_admin_rule():
    assert _check(target_role="member", new_role="member", new_is_active=False) is None


def test_inactive_admin_does_not_count_as_the_last_admin():
    assert _check(target_is_active=False, new_role="member", new_is_active=False) is None


def test_admin_cannot_deactivate_themselves_even_with_other_admins():
    result = _check(target_id=ME, new_is_active=False, other_active_admins=3)
    assert result[0] == "cannot_deactivate_self"


def test_admin_can_demote_themselves_when_another_admin_remains():
    assert _check(target_id=ME, new_role="member", other_active_admins=1) is None


def test_no_change_is_fine():
    assert _check() is None
