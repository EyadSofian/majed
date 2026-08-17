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

from ..utils.data_builder import build_full_payload, build_shop_context

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
        """Return the visitor's context.

        `auth='public'` on purpose: most of the sales funnel is guests, and a
        guest still needs `shop` so the bot quotes them in the currency the page
        beside it is already showing — a Saudi visitor in riyals, not pounds.
        Guests get *only* that; trainee data stays behind the login check below.
        """
        try:
            if request.env.user._is_public():
                return request.make_json_response({
                    'user': {},
                    'shop': build_shop_context(request.env),
                    'courses': [],
                    'learning_progress': {},
                })
            uid = request.env.uid
            payload = build_full_payload(request.env, uid)
            return request.make_json_response(payload)
        except Exception:
            _logger.exception('ai_webhook: failed to build user context')
            return request.make_json_response(
                {'error': 'Failed to load user context'},
                status=500,
            )
