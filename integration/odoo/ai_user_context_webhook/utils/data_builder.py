"""
Utility functions that build the JSON payload sent to the AI webhook.

Each builder receives an ``env`` (odoo.api.Environment) that is already
bound to the correct user and database.  Every builder returns plain
Python dicts / lists – never recordsets – so the result is immediately
JSON-serialisable.
"""

import logging
from datetime import datetime

_logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# 1. User information
# ------------------------------------------------------------------
def build_user_data(env, uid):
    """Return a dict describing the logged-in user."""
    user = env['res.users'].sudo().browse(uid)
    if not user.exists():
        return {}
    return {
        'user_id': user.id,
        'name': user.name or '',
        'email': user.email or '',
        'login': user.login or '',
        'company': user.company_id.name if user.company_id else '',
        'company_id': user.company_id.id if user.company_id else None,
        'timezone': user.tz or '',
        'language': user.lang or '',
    }


# ------------------------------------------------------------------
# 2. eLearning / LMS data  (depends on *website_slides*)
# ------------------------------------------------------------------
def _is_module_installed(env, module_name):
    """Check if an Odoo module is installed."""
    module = (
        env['ir.module.module']
        .sudo()
        .search([('name', '=', module_name), ('state', '=', 'installed')], limit=1)
    )
    return bool(module)


def build_courses_data(env, uid):
    """Return a list of course dicts with progress and content structure.

    Gracefully returns an empty list when the *website_slides* module is
    not installed.
    """
    if not _is_module_installed(env, 'website_slides'):
        return []

    user = env['res.users'].sudo().browse(uid)
    partner = user.partner_id
    if not partner:
        return []

    # All enrollments for this user
    enrollments = (
        env['slide.channel.partner']
        .sudo()
        .search([('partner_id', '=', partner.id)])
    )

    courses = []
    for enrollment in enrollments:
        channel = enrollment.channel_id
        if not channel:
            continue

        # --- course-level progress ---
        completed_count = enrollment.completed_slides_count or 0
        total_slides = channel.total_slides or 0
        progress = enrollment.completion or 0

        # --- per-slide completion lookup for this user ---
        slide_partners = {
            sp.slide_id.id: sp
            for sp in env['slide.slide.partner']
            .sudo()
            .search([
                ('channel_id', '=', channel.id),
                ('partner_id', '=', partner.id),
            ])
        }

        # --- content structure (sections + lessons) ---
        sections = []
        all_slides = (
            channel.slide_ids
            .sudo()
            .sorted(key=lambda s: (s.sequence, s.id))
        )

        current_section = None
        for slide in all_slides:
            if slide.is_category:
                current_section = {
                    'section_id': slide.id,
                    'section_name': slide.name or '',
                    'lessons': [],
                }
                sections.append(current_section)
            else:
                lesson = {
                    'lesson_id': slide.id,
                    'lesson_title': slide.name or '',
                    'lesson_type': slide.slide_category or '',
                    'lesson_order': slide.sequence,
                    'completion_time': slide.completion_time or 0.0,
                    'completed': bool(slide_partners.get(slide.id, {}) and
                                      getattr(slide_partners.get(slide.id), 'completed', False)),
                }
                if current_section is not None:
                    current_section['lessons'].append(lesson)
                else:
                    # Lesson outside any section — wrap it
                    sections.append({
                        'section_id': None,
                        'section_name': 'Uncategorised',
                        'lessons': [lesson],
                    })

        # --- last accessed / next lesson ---
        next_slide = enrollment.next_slide_id
        last_accessed = _find_last_accessed_slide(env, channel, partner)

        # Remaining = total minus completed
        remaining = max(total_slides - completed_count, 0)

        courses.append({
            'course_id': channel.id,
            'course_name': channel.name or '',
            'course_description': (channel.description or '').strip() or '',
            'course_total_lessons': total_slides,
            'course_total_duration': channel.total_time or 0.0,
            'progress_percentage': progress,
            'completed_lessons': completed_count,
            'total_lessons': total_slides,
            'last_accessed_lesson': last_accessed,
            'current_position_in_course': {
                'next_lesson_id': next_slide.id if next_slide else None,
                'next_lesson_title': next_slide.name if next_slide else None,
            },
            'remaining_lessons': remaining,
            'member_status': enrollment.member_status or '',
            'sections': sections,
        })

    return courses


def _find_last_accessed_slide(env, channel, partner):
    """Best-effort detection of the last slide the user interacted with.

    ``slide.slide.partner`` has no write_date we can rely on, so we use
    the *last completed* slide (highest id among completed) as a proxy.
    """
    last = (
        env['slide.slide.partner']
        .sudo()
        .search(
            [
                ('channel_id', '=', channel.id),
                ('partner_id', '=', partner.id),
                ('completed', '=', True),
            ],
            order='id desc',
            limit=1,
        )
    )
    if last and last.slide_id:
        return {
            'lesson_id': last.slide_id.id,
            'lesson_title': last.slide_id.name or '',
        }
    return None


# ------------------------------------------------------------------
# 3. Events / Activities  (depends on *event*)
# ------------------------------------------------------------------
def build_events_data(env, uid):
    """Return a list of event dicts the user is registered for.

    Gracefully returns an empty list when the *event* module is not
    installed.
    """
    if not _is_module_installed(env, 'event'):
        return []

    user = env['res.users'].sudo().browse(uid)
    partner = user.partner_id
    if not partner:
        return []

    registrations = (
        env['event.registration']
        .sudo()
        .search([('partner_id', '=', partner.id)])
    )

    events = []
    for reg in registrations:
        event = reg.event_id
        if not event:
            continue
        events.append({
            'event_id': event.id,
            'event_name': event.name or '',
            'event_date_begin': event.date_begin.isoformat() if event.date_begin else None,
            'event_date_end': event.date_end.isoformat() if event.date_end else None,
            'event_location': event.address_id.contact_address if event.address_id else '',
            'registration_status': reg.state or '',
        })

    return events


# ------------------------------------------------------------------
# 4. Full payload assembler
# ------------------------------------------------------------------
def build_full_payload(env, uid):
    """Assemble the complete webhook payload for a user."""
    user_data = build_user_data(env, uid)
    courses = build_courses_data(env, uid)
    events = build_events_data(env, uid)

    # Summarise learning progress across all courses
    if courses:
        avg_progress = sum(c['progress_percentage'] for c in courses) / len(courses)
        total_completed = sum(c['completed_lessons'] for c in courses)
        total_remaining = sum(c['remaining_lessons'] for c in courses)
    else:
        avg_progress = 0
        total_completed = 0
        total_remaining = 0

    return {
        'user': user_data,
        'courses': courses,
        'learning_progress': {
            'total_courses_enrolled': len(courses),
            'average_progress': round(avg_progress, 2),
            'total_completed_lessons': total_completed,
            'total_remaining_lessons': total_remaining,
        },
        'events': events,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
    }
