"""
HTTP controller that exposes the logged-in user's context as JSON.

Called by the Botpress webchat bootstrap JS (runs in the browser after
login) to feed trainee data into `window.botpress.updateUser()`.

Route: GET /ai_webhook/user_context
Auth:  public — a guest still needs the shop context (currency / language), but
       trainee data is keyed off the session, so a guest simply has none.
"""

import json
import logging

from odoo import http
from odoo.http import request

from ..utils.data_builder import build_full_payload, build_guest_payload

_logger = logging.getLogger(__name__)


class AIUserContextController(http.Controller):

    @http.route(
        '/ai_webhook/user_context',
        type='http',
        auth='public',
        methods=['GET'],
        cors='*',
    )
    def get_user_context(self, **kw):
        """Return the trainee context, or just the shop context for a guest.

        The route is public because the visitor's currency and language belong
        to the *website*, not to a user record — a guest who cannot read them
        gets quoted in the wrong currency. Which payload is returned is decided
        by ``request.session.uid`` alone: it comes from the session cookie and
        can never be set by the caller, so a guest cannot ask for a user's data.
        """
        try:
            uid = request.session.uid
            if not uid:
                return request.make_json_response(build_guest_payload(request.env))
            payload = build_full_payload(request.env, uid)
            return request.make_json_response(payload)
        except Exception:
            _logger.exception('ai_webhook: failed to build user context')
            return request.make_json_response(
                {'error': 'Failed to load user context'},
                status=500,
            )
