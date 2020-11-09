import * as Promise from 'bluebird';
import * as express from 'express';
import * as _ from 'lodash';

import * as eventTracker from '../event-tracker';
import * as constants from '../lib/constants';
import { checkInt, checkTruthy } from '../lib/validation';
import { doRestart, doPurge } from './common';

import * as applicationManager from '../compose/application-manager';
import { generateStep } from '../compose/composition-steps';
import { AuthorizedRequest } from '../lib/api-keys';

export function createV1Api(router: express.Router) {
	router.post('/v1/restart', (req: AuthorizedRequest, res, next) => {
		const appId = checkInt(req.body.appId);
		const force = checkTruthy(req.body.force) ?? false;
		eventTracker.track('Restart container (v1)', { appId });
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			res.status(401).json({
				status: 'failed',
				message: 'Application is not available',
			});
			return;
		}

		return doRestart(appId, force)
			.then(() => res.status(200).send('OK'))
			.catch(next);
	});

	const v1StopOrStart = (
		req: AuthorizedRequest,
		res: express.Response,
		next: express.NextFunction,
		action: 'start' | 'stop',
	) => {
		const appId = checkInt(req.params.appId);
		const force = checkTruthy(req.body.force) ?? false;
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}

		return applicationManager
			.getCurrentApps()
			.then(function (apps) {
				if (apps[appId] == null) {
					return res.status(400).send('App not found');
				}
				const app = apps[appId];
				let service = app.services[0];
				if (service == null) {
					return res.status(400).send('No services on app');
				}
				if (app.services.length > 1) {
					return res
						.status(400)
						.send(
							'Some v1 endpoints are only allowed on single-container apps',
						);
				}

				// check that the request is scoped to cover this application
				if (!req.auth.isScoped({ apps: [app.appId] })) {
					return res.status(401).send('Unauthorized');
				}

				applicationManager.setTargetVolatileForService(service.imageId, {
					running: action !== 'stop',
				});

				const stopOpts = { wait: true };
				const step = generateStep(action, { current: service, ...stopOpts });

				return applicationManager
					.executeStep(step, { force })
					.then(function () {
						if (action === 'stop') {
							return service;
						}
						// We refresh the container id in case we were starting an app with no container yet
						return applicationManager.getCurrentApps().then(function (apps2) {
							const app2 = apps2[appId];
							service = app2.services[0];
							if (service == null) {
								throw new Error('App not found after running action');
							}
							return service;
						});
					})
					.then((service2) =>
						res.status(200).json({ containerId: service2.containerId }),
					);
			})
			.catch(next);
	};

	const createV1StopOrStartHandler = (action: 'start' | 'stop') =>
		_.partial(v1StopOrStart, _, _, _, action);

	router.post('/v1/apps/:appId/stop', createV1StopOrStartHandler('stop'));
	router.post('/v1/apps/:appId/start', createV1StopOrStartHandler('start'));

	router.get('/v1/apps/:appId', (req: AuthorizedRequest, res, next) => {
		const appId = checkInt(req.params.appId);
		eventTracker.track('GET app (v1)', { appId });
		if (appId == null) {
			return res.status(400).send('Missing app id');
		}
		return Promise.join(
			applicationManager.getCurrentApps(),
			applicationManager.getStatus(),
			function (apps, status) {
				const app = apps[appId];
				const service = app?.services?.[0];
				if (service == null) {
					return res.status(400).send('App not found');
				}

				if (app.services.length > 1) {
					return res
						.status(400)
						.send(
							'Some v1 endpoints are only allowed on single-container apps',
						);
				}

				// handle the case where the appId is out of scope
				if (!req.auth.isScoped({ apps: [app.appId] })) {
					res.status(401).json({
						status: 'failed',
						message: 'Application is not available',
					});
					return;
				}

				// Don't return data that will be of no use to the user
				const appToSend = {
					appId,
					commit: status.commit!,
					containerId: service.containerId,
					env: _.omit(service.config.environment, constants.privateAppEnvVars),
					imageId: service.config.image,
					releaseId: service.releaseId,
				};

				return res.json(appToSend);
			},
		).catch(next);
	});

	router.post('/v1/purge', (req: AuthorizedRequest, res, next) => {
		const appId = checkInt(req.body.appId);
		const force = checkTruthy(req.body.force) ?? false;
		if (appId == null) {
			const errMsg = 'Invalid or missing appId';
			return res.status(400).send(errMsg);
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			res.status(401).json({
				status: 'failed',
				message: 'Application is not available',
			});
			return;
		}

		return doPurge(appId, force)
			.then(() => res.status(200).json({ Data: 'OK', Error: '' }))
			.catch(next);
	});
}
