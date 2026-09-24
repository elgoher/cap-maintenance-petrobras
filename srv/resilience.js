'use strict'

const { createLogger } = require('./logger')
const LOG = createLogger('petrobras.resilience')

/**
 * withRetry — exponential backoff retry utility.
 * Session 02: base implementation.
 * Session 03: adds structured logging on each retry attempt.
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 200) {
    let lastError
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (err) {
            lastError = err
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1)
                LOG.warn('withRetry attempt failed — retrying', {
                    attempt, maxRetries, delay_ms: delay,
                    error: err.message
                })
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
    }
    LOG.error('withRetry exhausted all attempts', {
        maxRetries, error: lastError.message
    })
    throw lastError
}

/**
 * CircuitBreaker — three-state machine (CLOSED / OPEN / HALF-OPEN).
 * Session 02: base implementation.
 * Session 03: logs state transitions via LOG.circuitBreaker().
 */
class CircuitBreaker {
    constructor({ threshold = 3, resetTimeout = 10_000, name = 'default' } = {}) {
        this.threshold    = threshold
        this.resetTimeout = resetTimeout
        this.name         = name
        this.state        = 'CLOSED'
        this.failures     = 0
        this.nextAttempt  = 0
    }

    async call(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                const err = new Error(`Circuit '${this.name}' is OPEN — rejecting call`)
                err.code  = 'CIRCUIT_OPEN'
                throw err
            }
            const prev = this.state
            this.state = 'HALF-OPEN'
            LOG.circuitBreaker(this.name, prev, 'HALF-OPEN')
        }

        try {
            const result = await fn()
            this._onSuccess()
            return result
        } catch (err) {
            this._onFailure()
            throw err
        }
    }

    _onSuccess() {
        if (this.state !== 'CLOSED') {
            LOG.circuitBreaker(this.name, this.state, 'CLOSED')
        }
        this.failures = 0
        this.state    = 'CLOSED'
    }

    _onFailure() {
        this.failures++
        if (this.failures >= this.threshold) {
            const prev = this.state
            this.state       = 'OPEN'
            this.nextAttempt = Date.now() + this.resetTimeout
            LOG.circuitBreaker(this.name, prev, 'OPEN')
        }
    }
}

module.exports = { withRetry, CircuitBreaker }
