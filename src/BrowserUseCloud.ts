/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';

const BROWSER_USE_API_BASE = 'https://api.browser-use.com/api/v2';

export interface BrowserSession {
  id: string;
  status: 'active' | 'stopped';
  timeoutAt: string;
  startedAt: string;
  liveUrl: string;
  cdpUrl: string;
  finishedAt?: string;
}

export interface CreateSessionOptions {
  /** Browser screen width */
  browserScreenWidth?: number;
  /** Browser screen height */
  browserScreenHeight?: number;
  /** Session timeout in minutes (default: 15) */
  timeout?: number;
  /** Proxy country code */
  proxyCountryCode?: string;
  /** Allow window resizing */
  allowResizing?: boolean;
  /** Profile ID for persistent sessions */
  profileId?: string;
}

export class BrowserUseCloud {
  private apiKey: string;
  private currentSession: BrowserSession | null = null;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'Browser Use Cloud API key is required. Set BROWSER_USE_API_KEY environment variable or use --browserUseApiKey flag.',
      );
    }
    this.apiKey = apiKey;
  }

  /**
   * Creates a new browser session in Browser Use Cloud
   */
  async createSession(
    options: CreateSessionOptions = {},
  ): Promise<BrowserSession> {
    logger('Creating Browser Use Cloud session...');

    const response = await fetch(`${BROWSER_USE_API_BASE}/browsers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Browser-Use-API-Key': this.apiKey,
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create Browser Use Cloud session: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const session = (await response.json()) as BrowserSession;
    this.currentSession = session;

    logger(`Browser Use Cloud session created: ${session.id}`);
    logger(`CDP URL: ${session.cdpUrl}`);
    logger(`Live URL: ${session.liveUrl}`);

    return session;
  }

  /**
   * Gets the current session details
   */
  async getSession(sessionId?: string): Promise<BrowserSession | null> {
    const id = sessionId ?? this.currentSession?.id;
    if (!id) {
      return null;
    }

    const response = await fetch(`${BROWSER_USE_API_BASE}/browsers/${id}`, {
      method: 'GET',
      headers: {
        'X-Browser-Use-API-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const errorText = await response.text();
      throw new Error(
        `Failed to get Browser Use Cloud session: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const session = (await response.json()) as BrowserSession;
    if (!sessionId) {
      this.currentSession = session;
    }
    return session;
  }

  /**
   * Stops the current or specified session
   */
  async stopSession(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.currentSession?.id;
    if (!id) {
      logger('No session to stop');
      return;
    }

    logger(`Stopping Browser Use Cloud session: ${id}`);

    const response = await fetch(`${BROWSER_USE_API_BASE}/browsers/${id}`, {
      method: 'DELETE',
      headers: {
        'X-Browser-Use-API-Key': this.apiKey,
      },
    });

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(
        `Failed to stop Browser Use Cloud session: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    if (!sessionId) {
      this.currentSession = null;
    }

    logger(`Browser Use Cloud session stopped: ${id}`);
  }

  /**
   * Gets the CDP WebSocket URL for the current session
   */
  getCdpUrl(): string | null {
    return this.currentSession?.cdpUrl ?? null;
  }

  /**
   * Gets the live view URL for the current session
   */
  getLiveUrl(): string | null {
    return this.currentSession?.liveUrl ?? null;
  }

  /**
   * Checks if there's an active session
   */
  hasActiveSession(): boolean {
    return this.currentSession?.status === 'active';
  }

  /**
   * Gets the current session
   */
  getCurrentSession(): BrowserSession | null {
    return this.currentSession;
  }
}
