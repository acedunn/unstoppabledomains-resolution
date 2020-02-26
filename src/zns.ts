import {
  fromBech32Address,
  toBech32Address,
  toChecksumAddress,
} from './zns/utils';
import namehash, { childhash } from './zns/namehash';
import { invert, set } from './utils';
import {
  Dictionary,
  ResolutionResponse,
  SourceDefinition,
  UnclaimedDomainResponse,
  ZnsResolution,
  NamingServiceSource,
  NamingServiceName,
  isNullAddress,
  nodeHash,
} from './types';
import { ResolutionError, ResolutionErrorCode } from './index';
import NamingService from './namingService';

const DefaultSource = 'https://api.zilliqa.com';

const NetworkIdMap = {
  1: 'mainnet',
  333: 'testnet',
  111: 'localnet',
};

const RegistryMap = {
  mainnet: 'zil1jcgu2wlx6xejqk9jw3aaankw6lsjzeunx2j0jz',
};

const UrlMap = {
  mainnet: 'https://api.zilliqa.com',
  testnet: 'https://dev-api.zilliqa.com',
  localnet: 'http://localhost:4201',
};

const UrlNetworkMap = (url: string) => invert(UrlMap)[url];

/**
 * Class to support connection with Zilliqa naming service
 * @param network - network string such as
 * - mainnet
 * - ropsten
 * @param url - main api url such as
 * - https://mainnet.infura.io
 * @param registryAddress - address for a registry contract
 */
export default class Zns extends NamingService {
  readonly name = NamingServiceName.ZNS;
  readonly network: string;
  readonly url: string;
  readonly registryAddress?: string;

  /**
   * Source object describing the network naming service operates on
   * @param source - if specified as a string will be used as main url, if omitted then defaults are used
   * @throws ConfigurationError - when either network or url is setup incorrectly
   */
  constructor(source: string | boolean | SourceDefinition = true) {
    super();
    source = this.normalizeSource(source);
    this.network = source.network as string;
    this.url = source.url as string;
    if (!this.network) {
      throw new Error('Unspecified network in Resolution ZNS configuration');
    }
    if (!this.url) {
      throw new Error('Unspecified url in Resolution ZNS configuration');
    }
    this.registryAddress = source.registry
      ? source.registry
      : RegistryMap[this.network];
    if (this.registryAddress) {
      this.registryAddress = this.registryAddress.startsWith('0x')
        ? toBech32Address(this.registryAddress)
        : this.registryAddress;
    }
  }

  /**
   * Resolves the domain name
   * @param domain - domain name to be resolved
   * @returns A promise that resolves in a detailed crypto Resolution
   */
  async resolve(domain: string): Promise<ResolutionResponse | null> {
    const recordAddresses = await this.getRecordsAddresses(domain);
    if (!recordAddresses) return UnclaimedDomainResponse;
    const [ownerAddress, resolverAddress] = recordAddresses;
    const Resolution = this.structureResolverRecords(
      await this.getResolverRecords(resolverAddress),
    );
    const addresses = {};
    if (Resolution.crypto)
      Object.entries(Resolution.crypto).map(
        ([key, v]) => (addresses[key] = v.address),
      );
    return {
      addresses,
      meta: {
        owner: ownerAddress || null,
        type: this.name,
        ttl: parseInt(Resolution.ttl as string) || 0,
      },
    };
  }

  /**
   * Resolves domain name to a particular crypto address associated with it
   * @param domain - domain name to be resolved
   * @param currencyTicker - specific currency ticker such as
   *  - ZIL
   *  - BTC
   *  - ETH
   * @returns A promise that resolves in a string
   * @throws ResolutionError
   */
  async address(domain: string, currencyTicker: string): Promise<string> {
    const data = await this.resolve(domain);
    if (!data!.meta.owner || isNullAddress(data!.meta.owner))
      throw new ResolutionError(ResolutionErrorCode.UnregisteredDomain, {
        domain,
      });
    const address = data!.addresses[currencyTicker.toUpperCase()];
    if (!address)
      throw new ResolutionError(ResolutionErrorCode.UnspecifiedCurrency, {
        domain,
        currencyTicker,
      });
    return address;
  }

  /**
   * Owner of the domain
   * @param domain - domain name
   * @returns An owner address of the domain
   */
  async owner(domain: string): Promise<string | null> {
    return (await this.resolve(domain))!.meta.owner;
  }

  /**
   * Resolves a domain
   * @param domain - domain name to be resolved
   * @returns Everything what is stored on specified domain
   */
  async Resolution(domain: string): Promise<ZnsResolution> {
    return this.structureResolverRecords(await this.records(domain));
  }

  async ipfsHash(domain: string): Promise<string> {
    return await this.getRecordOrThrow(domain, 'ipfs.html.value');
  }

  async httpUrl(domain: string): Promise<string> {
    return await this.getRecordOrThrow(domain, 'ipfs.redirect_domain.value');
  }

  async email(domain: string): Promise<string> {
    return await this.getRecordOrThrow(domain, 'whois.email.value');
  }

  /**
   * Resolves a specific field from domain's record
   * @param domain - domain name
   * @param field - resolver record name to be queried
   * @returns Record field associated with the domain
   */
  async record(domain: string, field: string) {
    return await this.getRecordOrThrow(domain, field);
  }

  /**
   * Resolver Records
   * @param domain - domain name to be resolved
   * @returns ZNS resolver records in an plain key-value format
   */
  async records(domain: string): Promise<Dictionary<string>> {
    return await this.getResolverRecords((await this.resolverAddress(domain))!);
  }

  /**
   * Checks if domain is supported by zns
   */
  isSupportedDomain(domain: string): boolean {
    const tokens = domain.split('.');
    return (tokens.length && tokens[tokens.length - 1] === 'zil' ) as boolean;
  }

  /**
   * Checks if zns is supported by current Resolution instance
   */
  isSupportedNetwork(): boolean {
    return this.registryAddress != null;
  }

  /**
   * Produces ZNS namehash of a domain
   * @param domain - domain name to be hashed
   * @returns ZNS namehash
   */
  namehash(domain: string): string {
    this.ensureSupportedDomain(domain);
    return namehash(domain);
  }

  /**
   * Returns the childhash
   * @param parent - nodehash of a parent
   * @param label - child
   */
  childhash(parent: nodeHash, label: string): string {
    return childhash(parent, label);
  }

  /**
   * get the resolver address from domain
   * @param domain - domain name
   * @throws ResolutionError with codes
   *  - UnregisteredDomain if there is no owner for such a domain
   *  - UnspecifiedResolver if there is no resolver for such a domain
   */
  async resolver(domain: string): Promise<string> {
    const recordsAddresses = await this.getRecordsAddresses(domain);
    if (!recordsAddresses || !recordsAddresses[0])
      throw new ResolutionError(ResolutionErrorCode.UnregisteredDomain, {
        domain: domain,
      });
    const [_, resolverAddress] = recordsAddresses;
    if (!resolverAddress || isNullAddress(resolverAddress))
      throw new ResolutionError(ResolutionErrorCode.UnspecifiedResolver, {
        domain: domain,
      });
    return resolverAddress;
  }

  /** @internal */
  protected normalizeSource(source: NamingServiceSource): SourceDefinition {
    switch (typeof source) {
      case 'boolean': {
        return { url: DefaultSource, network: 'mainnet' };
      }
      case 'string': {
        return {
          url: source as string,
          network: UrlNetworkMap(source),
        };
      }
      case 'object': {
        source = { ...source };
        if (typeof source.network == 'number') {
          source.network = NetworkIdMap[source.network];
        }
        if (source.registry) {
          source.network = source.network ? source.network : 'mainnet';
          source.url = source.url ? source.url : DefaultSource;
        }
        if (source.network && !source.url) {
          source.url = UrlMap[source.network];
        }
        if (source.url && !source.network) {
          source.network = UrlNetworkMap(source.url);
        }
        return source;
      }
    }
  }

  private async getRecordOrThrow(
    domain: string,
    field: string,
  ): Promise<string> {
    const records = await this.records(domain);
    return this.getRecordFieldOrThrow(domain, records, field);
  }

  private getRecordFieldOrThrow(
    domain: string,
    records: Dictionary<string>,
    field: string,
  ): string {
    if (!records || !records[field])
      throw new ResolutionError(ResolutionErrorCode.RecordNotFound, {
        domain,
        recordName: field,
      });
    return records[field];
  }

  private async getRecordsAddresses(
    domain: string,
  ): Promise<[string, string] | undefined> {
    if (!this.isSupportedDomain(domain) || !this.isSupportedNetwork())
      return undefined;
    const registryRecord = await this.getContractMapValue(
      this.registryAddress!,
      'records',
      namehash(domain),
    );
    if (!registryRecord) return undefined;
    let [ownerAddress, resolverAddress] = registryRecord.arguments as [
      string,
      string,
    ];
    if (ownerAddress.startsWith('0x')) {
      ownerAddress = toBech32Address(ownerAddress);
    }
    return [ownerAddress, resolverAddress];
  }

  private async getResolverRecords(
    resolverAddress: string,
  ): Promise<ZnsResolution> {
    if (!resolverAddress || isNullAddress(resolverAddress)) {
      return {};
    }
    const resolver = toChecksumAddress(resolverAddress);
    return ((await this.getContractField(resolver, 'records')) ||
      {}) as Dictionary<string>;
  }

  private structureResolverRecords(records: Dictionary<string>): ZnsResolution {
    const result = {};
    for (const [key, value] of Object.entries(records)) {
      set(result, key, value);
    }
    return result;
  }

  private async resolverAddress(domain: string): Promise<string | undefined> {
    return ((await this.getRecordsAddresses(domain)) || [])[1];
  }

  private async fetchSubState(
    contractAddress: string,
    field: string,
    keys: string[] = [],
  ): Promise<any> {
    const response = await this.fetch(this.url, {
      method: 'POST',
      body: JSON.stringify({
        id: '1',
        jsonrpc: '2.0',
        method: 'GetSmartContractSubState',
        params: [contractAddress.replace('0x', ''), field, keys],
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    }).then(res => res.json());
    return response.result;
  }

  private async getContractField(
    contractAddress: string,
    field: string,
    keys: string[] = [],
  ): Promise<any> {
    try {
      const contractAddr = contractAddress.startsWith('zil1')
        ? fromBech32Address(contractAddress)
        : contractAddress;
      let result = (await this.fetchSubState(contractAddr, field, keys)) || {};
      return result[field];
    } catch (err) {
      if (err.name == 'FetchError')
        throw new ResolutionError(ResolutionErrorCode.NamingServiceDown, {
          method: NamingServiceName.ZNS,
        });
      else throw err;
    }
  }

  private async getContractMapValue(
    contractAddress: string,
    field: string,
    key: string,
  ): Promise<any> {
    const record = await this.getContractField(contractAddress, field, [key]);
    return (record && record[key]) || null;
  }
}
