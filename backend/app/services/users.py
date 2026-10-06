import uuid


def check_user_update(
    *,
    actor_id: uuid.UUID,
    target_id: uuid.UUID,
    target_role: str,
    target_is_active: bool,
    new_role: str,
    new_is_active: bool,
    other_active_admins: int,
) -> tuple[str, str] | None:
    """Return (code, message) if the change breaks an organization rule, else None."""
    if actor_id == target_id and target_is_active and not new_is_active:
        return ("cannot_deactivate_self", "You cannot deactivate your own account")
    was_active_admin = target_role == "admin" and target_is_active
    stays_active_admin = new_role == "admin" and new_is_active
    if was_active_admin and not stays_active_admin and other_active_admins == 0:
        return ("last_admin", "An organization must have at least one active admin")
    return None
