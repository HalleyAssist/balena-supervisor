import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { child_process, fs } from 'mz';
import * as path from 'path';

import * as constants from '../lib/constants';
import { writeFileAtomic } from '../lib/fs-utils';

import log from '../lib/supervisor-console';
import Logger from '../logger';

export interface ConfigOptions {
	[key: string]: string | string[];
}

interface ExtlinuxFile {
	labels: {
		[labelName: string]: {
			[directive: string]: string;
		};
	};
	globals: { [directive: string]: string };
}

const bootMountPoint = `${constants.rootMountPoint}${constants.bootMountPoint}`;

async function remountAndWriteAtomic(
	file: string,
	data: string,
): Promise<void> {
	// Here's the dangerous part:
	await child_process.exec(
		`mount -t vfat -o remount,rw ${constants.bootBlockDevice} ${bootMountPoint}`,
	);
	await writeFileAtomic(file, data);
}

export interface BackendOptions {
	logger?: Logger;
}

export abstract class DeviceConfigBackend {
	protected options: BackendOptions = {};

	// Does this config backend support the given device type?
	public abstract matches(deviceType: string): boolean;

	// A function which reads and parses the configuration options from
	// specific boot config
	public abstract getBootConfig(): Promise<ConfigOptions>;

	// A function to take a set of options and flush to the configuration
	// file/backend
	public abstract setBootConfig(opts: ConfigOptions): Promise<void>;

	// Is the configuration option provided supported by this configuration
	// backend
	public abstract isSupportedConfig(configName: string): boolean;

	// Is this variable a boot config variable for this backend?
	public abstract isBootConfigVar(envVar: string): boolean;

	// Convert a configuration environment variable to a config backend
	// variable
	public abstract processConfigVarName(envVar: string): string;

	// Process the value if the environment variable, ready to be written to
	// the backend
	public abstract processConfigVarValue(
		key: string,
		value: string,
	): string | string[];

	// Return the env var name for this config option
	public abstract createConfigVarName(configName: string): string;

	// Allow a chosen config backend to be initialised
	public initialise(opts: BackendOptions): Promise<DeviceConfigBackend> {
		this.options = _.merge({}, this.options, opts);
		return Promise.resolve(this);
	}
}

export class RPiConfigBackend extends DeviceConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}CONFIG_`;
	private static bootConfigPath = `${bootMountPoint}/config.txt`;

	public static bootConfigVarRegex = new RegExp(
		'(' + _.escapeRegExp(RPiConfigBackend.bootConfigVarPrefix) + ')(.+)',
	);

	private static arrayConfigKeys = [
		'dtparam',
		'dtoverlay',
		'device_tree_param',
		'device_tree_overlay',
		'gpio',
	];
	private static forbiddenConfigKeys = [
		'disable_commandline_tags',
		'cmdline',
		'kernel',
		'kernel_address',
		'kernel_old',
		'ramfsfile',
		'ramfsaddr',
		'initramfs',
		'device_tree_address',
		'init_emmc_clock',
		'avoid_safe_mode',
	];

	public matches(deviceType: string): boolean {
		return _.startsWith(deviceType, 'raspberry') || deviceType === 'fincm3';
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		let configContents = '';

		if (await fs.exists(RPiConfigBackend.bootConfigPath)) {
			configContents = await fs.readFile(
				RPiConfigBackend.bootConfigPath,
				'utf-8',
			);
		} else {
			await fs.writeFile(RPiConfigBackend.bootConfigPath, '');
		}

		const conf: ConfigOptions = {};
		const configStatements = configContents.split(/\r?\n/);

		for (const configStr of configStatements) {
			// Don't show warnings for comments and empty lines
			const trimmed = _.trimStart(configStr);
			if (_.startsWith(trimmed, '#') || trimmed === '') {
				continue;
			}
			let keyValue = /^([^=]+)=(.*)$/.exec(configStr);
			if (keyValue != null) {
				const [, key, value] = keyValue;
				if (!_.includes(RPiConfigBackend.arrayConfigKeys, key)) {
					conf[key] = value;
				} else {
					if (conf[key] == null) {
						conf[key] = [];
					}
					const confArr = conf[key];
					if (!_.isArray(confArr)) {
						throw new Error(
							`Expected '${key}' to have a config array but got ${typeof confArr}`,
						);
					}
					confArr.push(value);
				}
				continue;
			}

			// Try the next regex instead
			keyValue = /^(initramfs) (.+)/.exec(configStr);
			if (keyValue != null) {
				const [, key, value] = keyValue;
				conf[key] = value;
			} else {
				log.warn(`Could not parse config.txt entry: ${configStr}. Ignoring.`);
			}
		}

		return conf;
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		let confStatements: string[] = [];

		_.each(opts, (value, key) => {
			if (key === 'initramfs') {
				confStatements.push(`${key} ${value}`);
			} else if (_.isArray(value)) {
				confStatements = confStatements.concat(
					_.map(value, entry => `${key}=${entry}`),
				);
			} else {
				confStatements.push(`${key}=${value}`);
			}
		});

		const confStr = `${confStatements.join('\n')}\n`;

		await remountAndWriteAtomic(RPiConfigBackend.bootConfigPath, confStr);
	}

	public isSupportedConfig(configName: string): boolean {
		return !_.includes(RPiConfigBackend.forbiddenConfigKeys, configName);
	}

	public isBootConfigVar(envVar: string): boolean {
		return _.startsWith(envVar, RPiConfigBackend.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string {
		return envVar.replace(RPiConfigBackend.bootConfigVarRegex, '$2');
	}

	public processConfigVarValue(key: string, value: string): string | string[] {
		if (_.includes(RPiConfigBackend.arrayConfigKeys, key)) {
			if (!_.startsWith(value, '"')) {
				return [value];
			} else {
				return JSON.parse(`[${value}]`);
			}
		}
		return value;
	}

	public createConfigVarName(configName: string): string {
		return RPiConfigBackend.bootConfigVarPrefix + configName;
	}
}

export class ExtlinuxConfigBackend extends DeviceConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}EXTLINUX_`;
	private static bootConfigPath = `${bootMountPoint}/extlinux/extlinux.conf`;

	public static bootConfigVarRegex = new RegExp(
		'(' + _.escapeRegExp(ExtlinuxConfigBackend.bootConfigVarPrefix) + ')(.+)',
	);

	private static suppportedConfigKeys = ['isolcpus'];

	public matches(deviceType: string): boolean {
		return _.startsWith(deviceType, 'jetson-tx');
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		let confContents: string;

		try {
			confContents = await fs.readFile(
				ExtlinuxConfigBackend.bootConfigPath,
				'utf-8',
			);
		} catch {
			// In the rare case where the user might have deleted extlinux conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			throw new Error(
				'Could not find extlinux file. Device is possibly bricked',
			);
		}

		const parsedBootFile = ExtlinuxConfigBackend.parseExtlinuxFile(
			confContents,
		);

		// First find the default label name
		const defaultLabel = _.find(parsedBootFile.globals, (_v, l) => {
			if (l === 'DEFAULT') {
				return true;
			}
			return false;
		});

		if (defaultLabel == null) {
			throw new Error('Could not find default entry for extlinux.conf file');
		}

		const labelEntry = parsedBootFile.labels[defaultLabel];

		if (labelEntry == null) {
			throw new Error(
				`Cannot find default label entry (label: ${defaultLabel}) for extlinux.conf file`,
			);
		}

		// All configuration options come from the `APPEND` directive in the default label entry
		const appendEntry = labelEntry.APPEND;

		if (appendEntry == null) {
			throw new Error(
				'Could not find APPEND directive in default extlinux.conf boot entry',
			);
		}

		const conf: ConfigOptions = {};
		const values = appendEntry.split(' ');
		for (const value of values) {
			const parts = value.split('=');
			if (this.isSupportedConfig(parts[0])) {
				if (parts.length !== 2) {
					throw new Error(
						`Could not parse extlinux configuration entry: ${values} [value with error: ${value}]`,
					);
				}
				conf[parts[0]] = parts[1];
			}
		}

		return conf;
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// First get a representation of the configuration file, with all balena-supported configuration removed
		let confContents: string;

		try {
			confContents = await fs.readFile(
				ExtlinuxConfigBackend.bootConfigPath,
				'utf-8',
			);
		} catch {
			// In the rare case where the user might have deleted extlinux conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			throw new Error(
				'Could not find extlinux file. Device is possibly bricked',
			);
		}

		const extlinuxFile = ExtlinuxConfigBackend.parseExtlinuxFile(
			confContents.toString(),
		);
		const defaultLabel = extlinuxFile.globals.DEFAULT;
		if (defaultLabel == null) {
			throw new Error(
				'Could not find DEFAULT directive entry in extlinux.conf',
			);
		}
		const defaultEntry = extlinuxFile.labels[defaultLabel];
		if (defaultEntry == null) {
			throw new Error(
				`Could not find default extlinux.conf entry: ${defaultLabel}`,
			);
		}

		if (defaultEntry.APPEND == null) {
			throw new Error(
				`extlinux.conf APPEND directive not found for default entry: ${defaultLabel}, not sure how to proceed!`,
			);
		}

		const appendLine = _.filter(defaultEntry.APPEND.split(' '), entry => {
			const lhs = entry.split('=');
			return !this.isSupportedConfig(lhs[0]);
		});

		// Apply the new configuration to the "plain" append line above

		_.each(opts, (value, key) => {
			appendLine.push(`${key}=${value}`);
		});

		defaultEntry.APPEND = appendLine.join(' ');
		const extlinuxString = ExtlinuxConfigBackend.extlinuxFileToString(
			extlinuxFile,
		);

		await remountAndWriteAtomic(
			ExtlinuxConfigBackend.bootConfigPath,
			extlinuxString,
		);
	}

	public isSupportedConfig(configName: string): boolean {
		return _.includes(ExtlinuxConfigBackend.suppportedConfigKeys, configName);
	}

	public isBootConfigVar(envVar: string): boolean {
		return _.startsWith(envVar, ExtlinuxConfigBackend.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string {
		return envVar.replace(ExtlinuxConfigBackend.bootConfigVarRegex, '$2');
	}

	public processConfigVarValue(_key: string, value: string): string {
		return value;
	}

	public createConfigVarName(configName: string): string {
		return `${ExtlinuxConfigBackend.bootConfigVarPrefix}${configName}`;
	}

	private static parseExtlinuxFile(confStr: string): ExtlinuxFile {
		const file: ExtlinuxFile = {
			globals: {},
			labels: {},
		};

		// Firstly split by line and filter any comments and empty lines
		let lines = confStr.split(/\r?\n/);
		lines = _.filter(lines, l => {
			const trimmed = _.trimStart(l);
			return trimmed !== '' && !_.startsWith(trimmed, '#');
		});

		let lastLabel = '';

		for (const line of lines) {
			const match = line.match(/^\s*(\w+)\s?(.*)$/);
			if (match == null) {
				log.warn(`Could not read extlinux entry: ${line}`);
				continue;
			}
			let directive = match[1].toUpperCase();
			let value = match[2];

			// Special handling for the MENU directive
			if (directive === 'MENU') {
				const parts = value.split(' ');
				directive = `MENU ${parts[0]}`;
				value = parts.slice(1).join(' ');
			}

			if (directive !== 'LABEL') {
				if (lastLabel === '') {
					// Global options
					file.globals[directive] = value;
				} else {
					// Label specific options
					file.labels[lastLabel][directive] = value;
				}
			} else {
				lastLabel = value;
				file.labels[lastLabel] = {};
			}
		}

		return file;
	}

	private static extlinuxFileToString(file: ExtlinuxFile): string {
		let ret = '';
		_.each(file.globals, (value, directive) => {
			ret += `${directive} ${value}\n`;
		});
		_.each(file.labels, (directives, key) => {
			ret += `LABEL ${key}\n`;
			_.each(directives, (value, directive) => {
				ret += `${directive} ${value}\n`;
			});
		});
		return ret;
	}
}

export type ConfigfsConfig = Dictionary<string[]>;

/**
 * A backend to handle ConfigFS host configuration for ACPI SSDT loading
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIGFS_ssdt = value | "value" | "value1","value2"
 */
export class ConfigfsConfigBackend extends DeviceConfigBackend {
	private readonly SystemAmlFiles = path.join(
		constants.rootMountPoint,
		'/boot/acpi-tables',
	);
	private readonly ConfigFilePath = path.join(
		constants.rootMountPoint,
		'/mnt/boot/configfs.txt',
	); // use constant for mount path, rename to ssdt.txt
	private readonly ConfigfsMountPoint = path.join(
		constants.rootMountPoint,
		'/sys/kernel/config',
	);
	private readonly ConfigVarNamePrefix = `${constants.hostConfigVarPrefix}CONFIGFS_`;

	// supported backend for the following device types...
	public static readonly SupportedDeviceTypes = ['up-board'];

	private stripPrefix(name: string): string {
		return name.substr(this.ConfigVarNamePrefix.length);
	}

	private async listLoadedAcpiTables(): Promise<string[]> {
		const acpiTablesDir = path.join(this.ConfigfsMountPoint, '/acpi/table');
		return await fs.readdir(acpiTablesDir);
	}

	private async loadAML(aml: string): Promise<boolean> {
		if (aml) {
			const amlSrcPath = path.join(this.SystemAmlFiles, `${aml}.aml`);
			// log to system log if the AML doesn't exist...
			if (!(await fs.exists(amlSrcPath))) {
				log.error(`Missing AML for \'${aml}\'. Unable to load.`);
				if (this.options.logger) {
					this.options.logger.logSystemMessage(
						`Missing AML for \'${aml}\'. Unable to load.`,
						{ aml, path: amlSrcPath },
						'Load AML error',
						false,
					);
				}
				return false;
			}

			const amlDstPath = path.join(this.ConfigfsMountPoint, '/acpi/table', aml);
			try {
				const loadedTables = await this.listLoadedAcpiTables();

				if (loadedTables.indexOf(aml) < 0) {
					await fs.mkdir(amlDstPath);
				}

				log.info(`Loading AML ${aml}`);
				await child_process.exec(
					`cat ${amlSrcPath} > ${path.join(amlDstPath, 'aml')}`,
				);

				const [oemId, oemTableId, oemRevision] = await Bluebird.all([
					fs.readFile(path.join(amlDstPath, 'oem_id'), 'utf8'),
					fs.readFile(path.join(amlDstPath, 'oem_table_id'), 'utf8'),
					fs.readFile(path.join(amlDstPath, 'oem_revision'), 'utf8'),
				]);

				log.info(
					`AML: ${oemId.trim()} ${oemTableId.trim()} (Rev ${oemRevision.trim()})`,
				);
			} catch (e) {
				log.error(e);
			}
			return true;
		}
		return false;
	}

	private async readConfigTxt(): Promise<ConfigfsConfig> {
		// if we don't yet have a config file, just return an empty result...
		if (!(await fs.exists(this.ConfigFilePath))) {
			log.info('Empty ConfigFS config file');
			return {};
		}

		// read the config file and split by newline...
		const content = (await fs.readFile(this.ConfigFilePath, 'utf8')).split(
			'\n',
		);

		// lines starting with # are comments, otherwise its split into (group 1) = (group 2)
		const parseLineRegex = /^(?!\#)(.+?)\s*\=\s*(.+)/;

		// parse each line of the config file, remove any bad entries, then return a ConfigfsConfig from them...
		return content
			.map(line => {
				const result = {
					name: '',
					value: '',
				};
				const matches = line.match(parseLineRegex);
				if (matches && matches.length >= 3) {
					const [, name, value] = matches;
					result.name = name;
					result.value = value;
				}
				return result;
			})
			.filter(line => line.name !== '')
			.reduce((config: ConfigfsConfig, { name, value }) => {
				if (!config[name]) {
					config[name] = [value];
				} else {
					config[name].push(value);
				}
				return config;
			}, {});
	}

	private async writeConfigTxt(config: ConfigfsConfig): Promise<void> {
		const lines: string[] = [];
		Object.keys(config).forEach(key => {
			config[key].forEach(v => {
				lines.push(`${key} = ${v}`);
			});
		});

		const content = lines.join('\r\n') + '\r\n';
		await writeFileAtomic(this.ConfigFilePath, content);
	}

	private async loadConfiguredSsdt(config: ConfigfsConfig): Promise<void> {
		if (config['ssdt'] !== undefined && _.isArray(config['ssdt'])) {
			log.info('Loading configured SSDTs');
			await Bluebird.mapSeries(config['ssdt'], aml => this.loadAML(aml));
		}
	}

	public async initialise(
		opts: BackendOptions,
	): Promise<ConfigfsConfigBackend> {
		try {
			super.initialise(opts);

			// load the acpi_configfs module...
			await child_process.exec('modprobe acpi_configfs');

			// read the existing config file...
			const config = await this.readConfigTxt();

			// write the config back out (reformatting it)
			await this.writeConfigTxt(config);

			// load the configured SSDT AMLs...
			await this.loadConfiguredSsdt(config);
			log.success('Initialised ConfigFS');
		} catch (error) {
			log.error(error);
			if (this.options.logger) {
				this.options.logger.logSystemMessage(
					'Unable to initialise ConfigFS',
					{ error },
					'ConfigFS initialisation error',
				);
			}
		}
		return this;
	}

	public matches(deviceType: string): boolean {
		return ConfigfsConfigBackend.SupportedDeviceTypes.includes(deviceType);
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		const options: ConfigOptions = {};

		// read the config file...
		const config = await this.readConfigTxt();

		// see which SSDTs we have configured...
		const ssdt = config['ssdt'];
		if (_.isArray(ssdt) && ssdt.length > 0) {
			// we have some...
			options['ssdt'] = ssdt;
		}
		return options;
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// read the config file...
		const config = await this.readConfigTxt();

		// see if the target state defined some SSDTs...
		const ssdtKey = `${this.ConfigVarNamePrefix}ssdt`;
		if (opts[ssdtKey]) {
			// it did, so update the config with theses...
			const ssdt = opts[ssdtKey];
			const ssdts = _.isArray(ssdt) ? ssdt : [ssdt];
			config['ssdt'] = ssdts;
		} else {
			// it did not, so remove any existing SSDTs from the config...
			delete config['ssdt'];
		}

		// store the new config to disk...
		this.writeConfigTxt(config);
	}

	public isSupportedConfig(name: string): boolean {
		switch (this.stripPrefix(name)) {
			case 'ssdt':
				return true;
			default:
				return false;
		}
	}

	public isBootConfigVar(name: string): boolean {
		switch (this.stripPrefix(name)) {
			case 'ssdt':
				return true;
			default:
				return false;
		}
	}

	public processConfigVarName(name: string): string {
		return name;
	}

	public processConfigVarValue(name: string, value: string): string | string[] {
		switch (this.stripPrefix(name)) {
			case 'ssdt':
				// value could be a single value, so just add to an array and return...
				if (!_.startsWith(value, '"')) {
					return [value];
				} else {
					// or, it could be parsable as the content of a JSON array; "value" | "value1","value2"
					return JSON.parse(`[${value}]`) as string[];
				}
			default:
				return value;
		}
	}

	public createConfigVarName(name: string): string {
		return `${this.ConfigVarNamePrefix}${name}`;
	}
}
