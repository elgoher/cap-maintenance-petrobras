'use strict'

const cds = require('@sap/cds')

/**
 * Structured logger factory — Session 03 addition.
 *
 * Wraps cds.log() to add consistent field shapes across the application.
 * In production (NODE_ENV=production), cds.log outputs JSON to stdout,
 * making it compatible with SAP BTP Application Logging Service (Kibana/ELK).
 *
 * Usage:
 *   const { createLogger } = require('./logger')
 *   const LOG = createLogger('petrobras.parts-catalog')
 *   LOG.info('API called', { partCode, duration_ms: 42 })
 *
 * Output (production JSON):
 *   { "level": "info", "msg": "API called", "component": "petrobras.parts-catalog",
 *     "partCode": "P-SEAL-001", "duration_ms": 42, "timestamp": "..." }
 */
function createLogger(component) {
    const LOG = cds.log(component)

    return {

        info(msg, fields = {}) {
            LOG.info(msg, { component, ...fields })
        },

        warn(msg, fields = {}) {
            LOG.warn(msg, { component, ...fields })
        },

        error(msg, fields = {}) {
            LOG.error(msg, { component, ...fields })
        },

        // ── Semantic helpers ──────────────────────────────────────────────────

        /** Log an outgoing external API call with timing and result. */
        apiCall(service, path, durationMs, outcome) {
            const level = outcome === 'ok' ? 'info' : 'warn'
            LOG[level]('external_api_call', {
                component,
                service,
                path,
                duration_ms: durationMs,
                outcome                    // 'ok' | 'unavailable' | 'rejected'
            })
        },

        /** Log a circuit breaker state transition. */
        circuitBreaker(service, fromState, toState) {
            LOG.warn('circuit_breaker_transition', {
                component,
                service,
                from: fromState,
                to:   toState
            })
        },

        /** Log a domain event emission. */
        event(msg, fields = {}) {
            LOG.info(msg, { component, event: true, ...fields })
        }
    }
}

module.exports = { createLogger }
