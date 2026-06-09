"""
HTTP controller that exposes the logged-in user's context as JSON.

Called by the Botpress webchat bootstrap JS (runs in the browser after
login) to feed trainee data into `window.botpress.updateUser()`.

Route: GET /ai_webhook/user_context
Auth:  user (session cookie — the same session that just logged in)
"""

import json
import logging

from odoo import http
from odoo.http import request

from ..utils.data_builder import build_full_payload

_logger = logging.getLogger(__name__)


class AIUserContextController(http.Controller):

    @http.route(
        '/ai_webhook/user_context',
        type='http',
        auth='user',
        methods=['GET'],
        cors='*',
    )
    def get_user_context(self, **kw):
        """Return the full trainee context for the current logged-in user."""
        try:
            uid = request.env.uid
            payload = build_full_payload(request.env, uid)
            return request.make_json_response(payload)
        except Exception:
            _logger.exception('ai_webhook: failed to build user context')
            return request.make_json_response(
                {'error': 'Failed to load user context'},
                status=500,
            )
