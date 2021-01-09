import set from 'lodash/set';
import omit from 'lodash/omit';
import {
  GET_ONE,
  GET_LIST,
  GET_MANY,
  GET_MANY_REFERENCE,
  DELETE,
  CREATE,
  UPDATE,
  UPDATE_MANY,
  DELETE_MANY,
} from './fetchActions';

import getFinalType from './getFinalType';

const buildGetListVariables = (introspectionResults) => (
  resource,
  aorFetchType,
  params
) => {
  const result = {};
  let { filter: filterObj = {} } = params;
  const { customFilters = [] } = params;

  /**
         keys with comma separated values
        {
            'title@ilike,body@like,authors@similar': 'test',
            'col1@like,col2@like': 'val'
        }
     */
  const orFilterKeys = Object.keys(filterObj).filter((e) => e.includes(','));
  /**
        format filters
        {
            'title@ilike': 'test',
            'body@like': 'test',
            'authors@similar': 'test',
            'col1@like': 'val',
            'col2@like': 'val'
        }
    */

  /*
  "email@_like,user_profile": {
      "firstName@_like,user_profile": {
        "lastName@_like,stripe_customer_id@_like": "a"
      },
    },

    fold into

  email@_like,user_profile . firstName@_like,user_profile . lastName@_like,stripe_customer_id@_like" : "a"
  */
  const folding = (object, results) => {
    // if object
    if (typeof object === 'object' && object !== null) {
      const key = Object.keys(object)[0];
      return folding(object[key], results + '.' + key);
    }
    // else string
    else {
      return results + '=' + object;
    }
  };

  // clean up those filterKeys
  var newFilterObjOR = {};
  for (const idx in orFilterKeys) {
    const key = orFilterKeys[idx];
    const result = folding(filterObj[key], key);
    const splitted = result.split('=');
    newFilterObjOR[splitted[0]] = splitted[1];
  }

  const orFilterObj = Object.keys(newFilterObjOR).reduce(
    (acc, commaSeparatedKey) => {
      const keys = commaSeparatedKey.split(',');
      return {
        ...acc,
        ...keys.reduce((acc2, key) => {
          return {
            ...acc2,
            [key]: newFilterObjOR[commaSeparatedKey],
          };
        }, {}),
      };
    },
    {}
  );

  filterObj = omit(filterObj, orFilterKeys);
  const filterReducer = (obj) => (acc, key) => {
    let filter;
    if (key === 'ids') {
      filter = { id: { _in: obj['ids'] } };
    } else if (Array.isArray(obj[key])) {
      filter = { [key]: { _in: obj[key] } };
    } else if (obj[key] && obj[key].format === 'hasura-raw-query') {
      filter = { [key]: obj[key].value || {} };
    } else {
      let [keyName, operation = ''] = key.split('@');

      // filter with relationship, fold it into an object for query relationship
      // like: `user_profile.firstName@_ilike`
      if (keyName.includes('.')) {
        const items = keyName.split('.');
        var result = {
          [operation || '_eq']: operation.includes('like')
            ? `%${obj[key]}%`
            : obj[key],
        };
        for (var i = items.length; i > 0; i--) {
          result = { [items[i - 1]]: result };
        }
        filter = result;
      } else {
        // case without relationship
        const field = resource.type.fields.find((f) => f.name === keyName);
        switch (getFinalType(field.type).name) {
          case 'String':
            operation = operation || '_ilike';
            filter = {
              [keyName]: {
                [operation]: operation.includes('like')
                  ? `%${obj[key]}%`
                  : obj[key],
              },
            };
            break;
          default:
            filter = { [keyName]: { [operation || '_eq']: obj[key] } };
        }
      }
    }
    return [...acc, filter];
  };
  const andFilters = Object.keys(filterObj).reduce(
    filterReducer(filterObj),
    customFilters
  );
  const orFilters = Object.keys(orFilterObj).reduce(
    filterReducer(orFilterObj),
    []
  );

  result['where'] = {
    _and: andFilters,
    ...(orFilters.length && { _or: orFilters }),
  };

  if (params.pagination) {
    result['limit'] = parseInt(params.pagination.perPage, 10);
    result['offset'] = parseInt(
      (params.pagination.page - 1) * params.pagination.perPage,
      10
    );
  }

  if (params.sort) {
    result['order_by'] = set(
      {},
      params.sort.field,
      params.sort.order.toLowerCase()
    );
  }

  return result;
};

const buildUpdateVariables = (resource, aorFetchType, params, queryType) =>
  Object.keys(params.data).reduce((acc, key) => {
    // If hasura permissions do not allow a field to be updated like (id),
    // we are not allowed to put it inside the variables
    // RA passes the whole previous Object here
    // https://github.com/marmelab/react-admin/issues/2414#issuecomment-428945402

    // TODO: To overcome this permission issue,
    // it would be better to allow only permitted inputFields from *_set_input INPUT_OBJECT
    if (params.previousData && params.data[key] === params.previousData[key]) {
      return acc;
    }

    if (resource.type.fields.some((f) => f.name === key)) {
      return {
        ...acc,
        [key]: params.data[key],
      };
    }

    return acc;
  }, {});

const buildCreateVariables = (resource, aorFetchType, params, queryType) => {
  return params.data;
};

export default (introspectionResults) => (
  resource,
  aorFetchType,
  params,
  queryType
) => {
  switch (aorFetchType) {
    case GET_LIST:
      return buildGetListVariables(introspectionResults)(
        resource,
        aorFetchType,
        params,
        queryType
      );
    case GET_MANY_REFERENCE: {
      var built = buildGetListVariables(introspectionResults)(
        resource,
        aorFetchType,
        params,
        queryType
      );
      if (params.filter) {
        return {
          ...built,
          where: {
            _and: [
              ...built['where']['_and'],
              { [params.target]: { _eq: params.id } },
            ],
          },
        };
      }
      return {
        ...built,
        where: {
          [params.target]: { _eq: params.id },
        },
      };
    }
    case GET_MANY:
    case DELETE_MANY:
      return {
        where: { id: { _in: params.ids } },
      };

    case GET_ONE:
      return {
        where: { id: { _eq: params.id } },
        limit: 1,
      };

    case DELETE:
      return {
        where: { id: { _eq: params.id } },
      };
    case CREATE:
      return {
        objects: buildCreateVariables(
          resource,
          aorFetchType,
          params,
          queryType
        ),
      };

    case UPDATE:
      return {
        _set: buildUpdateVariables(resource, aorFetchType, params, queryType),
        where: { id: { _eq: params.id } },
      };

    case UPDATE_MANY:
      return {
        _set: buildUpdateVariables(resource, aorFetchType, params, queryType),
        where: { id: { _in: params.ids } },
      };
  }
};
